//! 模糊匹配：把「我想抢高数」「体育 张」这类**人的说法**落成具体的教学班。
//!
//! 为什么不直接用教务的查询接口：
//!
//! 1. 教务的 `query-lesson` 是**包含**匹配，而且课程名 / 教学班名 / 教师是三个独立字段
//!    —— 输入「高数」（课程全名是「高等数学（上）」）什么都搜不到，而「打得出速度」
//!    恰恰是抢课窗口前唯一要紧的事。
//! 2. 抢课真正要的不是「查到」，是「**在这些班里挑一个动手**」：有空位的优先、
//!    没选过的优先、匹配度高的优先。这层排序教务不给，得我们自己定。
//!
//! 匹配语义就三条，别再加：
//!
//! - 用空白切词，**每个词都要命中**（AND）；词可以落在任意字段上
//!   （课程名 / 课程代码 / 教师 / 上课时间地点）；
//! - 一个词命中任意**连续子串**即算，退一步允许**散落子序列**（「高数」→「高等数学」），
//!   但分数更低 —— 这是「模糊」的全部含义；
//! - 排序键：没选过的在前 → 有空位的在前 → 匹配分高的在前 → 剩余名额多的在前 → id 稳定兜底。
//!   前两项是**抢课语义**而不是相关性：已经选上的不该再抢，有名额的一定比满员的值得先出手。
//!
//! 全是纯函数：没有网络也没有库，所以它说的每一条都能被单测钉死
//! （`grab.rs` 的解析器与界面预览共用这一个实现，两边永远不会各说各话）。

use serde_json::Value;

use super::models::{CourseSelectLesson, GrabMatch};

/// 命中字段 —— 界面据此解释「为什么匹配到它」，这是模糊匹配可信度的全部来源。
pub const HIT_COURSE: &str = "course";
pub const HIT_CODE: &str = "code";
pub const HIT_TEACHER: &str = "teacher";
pub const HIT_PLACE: &str = "place";
/// 教师名**精确命中**（全名全等）。这不是「相关」而是「指定」——
/// 解析计划时只抢这位老师的班，见 [`preferred`]。
pub const HIT_TEACHER_EXACT: &str = "teacherExact";
/// 教师名**近似命中**（姓对了、其余最多差一个字）：名字打错时的退路。
pub const HIT_TEACHER_NEAR: &str = "teacherNear";

/// 一条命中。`lesson` 是克隆出来的：调用方（解析器）要拿它建任务，得能自己持有。
#[derive(Debug, Clone)]
pub struct LessonHit {
    pub lesson: CourseSelectLesson,
    pub score: i32,
    /// 命中的字段（见几个 `HIT_*` 常量），按字段权重降序
    pub fields: Vec<&'static str>,
    /// **有词精确命中了教师名** —— 「我就要这位老师的课」这个意思的唯一判据。
    ///
    /// 单独一个字段而不是从 `fields` 里查：解析器与排序都要读它，
    /// 而 `fields` 是给人看的清单（它可能因为别的词也命中而被拼得更长）。
    pub hard: bool,
}

/// 不透明 id → 纯文本。
///
/// **不能直接 `to_string()`**：字符串型 id 会带上引号（`"123"` 而不是 `123`），
/// 与前端 `idOf()` 的 `String(v)` 就不是一个东西了。带 `lessonAssoc` 的教训在前 ——
/// 类型对不对，教务是会直接拒绝的。
pub fn id_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 归一化：小写化 + 抹掉空白与常见分隔符。
///
/// 「高等数学（上）」与「高等数学(上)」「高等数学 上」对用户是一回事，
/// 对字符比较却是三种东西 —— 归一化就是为了让它们先变成同一种。
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|c| {
            !c.is_whitespace()
                && !matches!(
                    c,
                    '(' | ')' | '（' | '）' | '[' | ']' | '【' | '】' | '·' | '-' | '_' | '—'
                        | '/' | '\\' | '、' | ',' | '，' | '.' | '。' | ':' | '：'
                )
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 散落子序列命中：`needle` 的字符按序出现在 `hay` 里即可，不要求连续。
///
/// 分数按**被打散的程度**扣：span 越接近 needle 长度越像一次真命中
/// （「高数」落在「高等数学」上是 3，落在「高等数学与工程数学」上是 8）。
fn subsequence_score(hay: &[char], needle: &[char]) -> Option<i32> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let mut cursor = 0usize;
    let mut first: Option<usize> = None;
    let mut last = 0usize;
    for &nc in needle {
        let found = hay[cursor..].iter().position(|&hc| hc == nc)?;
        let at = cursor + found;
        first.get_or_insert(at);
        last = at;
        cursor = at + 1;
    }
    let first = first?;
    let span = (last - first + 1) as i32;
    let scattered = span - needle.len() as i32;
    Some(360 - scattered * 12 - first.min(40) as i32)
}

/// 一个词在一个字段里的得分。命中不了返回 None。
fn field_score(text: &str, token: &str) -> Option<i32> {
    let hay_s = normalize(text);
    if hay_s.is_empty() {
        return None;
    }
    let hay: Vec<char> = hay_s.chars().collect();
    let needle: Vec<char> = token.chars().collect();
    if needle.is_empty() {
        return None;
    }
    if hay == needle {
        return Some(1000);
    }
    // 连续子串：越靠前越相关，词首命中再加一档
    if let Some(pos) = hay_s.find(token) {
        let at = hay_s[..pos].chars().count() as i32;
        return Some(700 - at.min(60) + if at == 0 { 120 } else { 0 });
    }
    subsequence_score(&hay, &needle)
}

/// 字段权重（百分比）。课程名最重 —— 人报课名，不报代码。
const W_COURSE: i32 = 100;
const W_CODE: i32 = 85;
const W_TEACHER: i32 = 75;
const W_PLACE: i32 = 50;

/// 教师名全等的得分。**压过任何子串/子序列命中** —— 用户把名字打全了，那是在「指定」，
/// 不是在「找相关的课」。
const TEACHER_EXACT_SCORE: i32 = 1_000;
/// 教师名近似命中（姓对了、其余最多差一个字）的得分。
///
/// 刻意压低：它是「名字打错了」的退路，不该盖过任何一个正经命中 ——
/// 否则一个错字就会把真正该命中的课挤下去。
const TEACHER_NEAR_SCORE: i32 = 240;

/// 一个教学班身上可匹配的字段。
enum Field {
    Course(String),
    Code(String),
    /// 教师：既留逐个人名（精确/近似要靠它），也留拼接文本（通用打分要用）
    Teacher { names: Vec<String>, joined: String },
    Place(String),
}

/// 一次字段命中：得分 + 它算哪种命中（教师精确/近似会换成专门的标签）。
struct FieldHit {
    score: i32,
    tag: &'static str,
}

/// 一个教学班身上所有可匹配的字段，按权重降序。
fn fields_of(l: &CourseSelectLesson) -> Vec<Field> {
    let mut out: Vec<Field> = Vec::new();
    let course = l.course.as_ref();
    for name in [
        course.and_then(|c| c.name_zh.clone()),
        course.and_then(|c| c.name_en.clone()),
    ]
    .into_iter()
    .flatten()
    {
        if !name.trim().is_empty() {
            out.push(Field::Course(name));
        }
    }
    if let Some(code) = course.and_then(|c| c.code.clone()) {
        if !code.trim().is_empty() {
            out.push(Field::Code(code));
        }
    }
    // 教师：教务给的是对象数组，形状见过两种（`nameZh` 与 `person.nameZh`）
    let names = teacher_names(l);
    if !names.is_empty() {
        out.push(Field::Teacher {
            joined: names.join("、"),
            names,
        });
    }
    // 上课时间地点：形状没样本（教务可能给字符串，也可能给对象），
    // 所以把所有能读出来的字符串叶子拼起来 —— 只为「搜周三」这类用法，权重最低。
    let place: Vec<String> = l
        .schedule_groups
        .iter()
        .flat_map(|g| string_leaves(&g.date_time_place))
        .collect();
    if !place.is_empty() {
        out.push(Field::Place(place.join(" ")));
    }
    out
}

/// 递归收集 JSON 里的字符串叶子（数字/布尔不算：`weekday: 1` 匹配「1」只会添乱）。
fn string_leaves(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().flat_map(string_leaves).collect(),
        Value::Object(o) => o.values().flat_map(string_leaves).collect(),
        _ => Vec::new(),
    }
}

/// 一个词在某个人名上是不是「**打错了**」：姓要对上，其余最多差一个字。
///
/// 中文名的错字基本都长这样（张玮 → 张伟）。三条边界都是刻意的：
/// - **单字查询不放行**：只打姓氏时「张」该靠子串匹配（那是正经命中，分数还更高），
///   放宽它会让「张」去匹配「李娜」。
/// - **姓氏必须对上**：没有这条，「张伟」会命中「李伟」—— 那是两个人。
/// - **一字之差**：两个字的查询只允许差一个，三个字只允许差一个（不是按比例）。
fn near_miss_name(name: &str, token: &str) -> bool {
    let n: Vec<char> = normalize(name).chars().collect();
    let q: Vec<char> = token.chars().collect();
    if q.len() < 2 || n.is_empty() || n[0] != q[0] {
        return false;
    }
    lcs_len(&n, &q) + 1 >= q.len()
}

/// 最长公共子序列长度。名字都是两三个字，朴素 DP 足够，不必省这点。
fn lcs_len(a: &[char], b: &[char]) -> usize {
    let mut prev = vec![0usize; b.len() + 1];
    let mut cur = vec![0usize; b.len() + 1];
    for &ca in a {
        for (j, &cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb {
                prev[j] + 1
            } else {
                cur[j].max(prev[j + 1])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
        for v in cur.iter_mut() {
            *v = 0;
        }
    }
    prev[b.len()]
}

/// 一个词在一个字段里的命中。教师字段有自己的一套：**精确 → 通用 → 近似**，
/// 精确独占（返回即结束），通用与近似取分高的那个。
fn field_hit(field: &Field, token: &str) -> Option<FieldHit> {
    let (text, tag, weight) = match field {
        Field::Course(t) => (t.clone(), HIT_COURSE, W_COURSE),
        Field::Code(t) => (t.clone(), HIT_CODE, W_CODE),
        Field::Place(t) => (t.clone(), HIT_PLACE, W_PLACE),
        Field::Teacher { names, joined } => {
            // ① 全名全等 = 「指定」，直接定论
            if names.iter().any(|n| normalize(n) == token) {
                return Some(FieldHit {
                    score: TEACHER_EXACT_SCORE * W_TEACHER / 100,
                    tag: HIT_TEACHER_EXACT,
                });
            }
            // ② 通用命中（子串 / 子序列）。它比「近似」更硬：`张伟` 落在 `张伟明` 上
            //    是一次正经的子串命中，不该被降级成「可能打错了」
            let generic = field_score(joined, token).map(|s| FieldHit {
                score: s * W_TEACHER / 100,
                tag: HIT_TEACHER,
            });
            // ③ 近似（姓对了、其余最多差一个字）：名字打错时的退路，分数压得很低
            let near = names
                .iter()
                .find(|n| near_miss_name(n, token))
                .map(|n| {
                    // 名字越接近（长度越对得上）越可信：查「张玮」时「张伟」该排在「张伟明」前面
                    let slack = (n.chars().count() as i32 - token.chars().count() as i32).abs();
                    FieldHit {
                        score: (TEACHER_NEAR_SCORE - slack * 20) * W_TEACHER / 100,
                        tag: HIT_TEACHER_NEAR,
                    }
                });
            return match (generic, near) {
                (Some(g), Some(n)) => Some(if g.score >= n.score { g } else { n }),
                (Some(g), None) => Some(g),
                (None, Some(n)) => Some(n),
                (None, None) => None,
            };
        }
    };
    field_score(&text, token).map(|s| FieldHit {
        score: s * weight / 100,
        tag,
    })
}

/// 一个教学班对一组词的匹配结果：**全部词都命中**才算命中。
///
/// 返回 `(总分, 命中字段（去重、按字段权重序）, 有没有精确命中教师)`。
fn hit_of(fields: &[Field], tokens: &[String]) -> Option<(i32, Vec<&'static str>, bool)> {
    let mut total = 0i32;
    let mut used: Vec<&'static str> = Vec::new();
    let mut hard = false;
    for token in tokens {
        // 一个词可能同时落在多个字段上（「张伟」既是教师名、也可能出现在课名里）：
        // **分数取最高的那个，但每个命中都要记下来** —— 精确命中的教师要能被看见，
        // 不能因为课名那次命中分更高就被吞掉。
        let mut best: Option<i32> = None;
        for field in fields {
            let Some(h) = field_hit(field, token) else { continue };
            best = Some(best.map(|b| b.max(h.score)).unwrap_or(h.score));
            if h.tag == HIT_TEACHER_EXACT {
                hard = true;
            }
            if !used.contains(&h.tag) {
                used.push(h.tag);
            }
        }
        total += best?;
    }
    Some((total, used, hard))
}

/// 计划要抢的那一批。
///
/// **有词精确命中了教师名 → 只抢这位老师的班。** 用户把名字打全了，那是「指定」而不是
/// 「相关」：「张伟」不该顺手把「张伟明」的班也拖进志愿组 —— 抢到一门老师不对的课，
/// 比没抢到更麻烦（还得去退）。
///
/// 没有精确命中时**原样返回**，交给模糊匹配去排。这正是「输入错误就退回模糊」那条路：
/// 只打了姓（`张`）、或者打错一个字（`张玮`），都走这里 —— 近似命中只加分、不独占。
pub fn preferred(hits: &[LessonHit]) -> Vec<LessonHit> {
    if hits.iter().any(|h| h.hard) {
        hits.iter().filter(|h| h.hard).cloned().collect()
    } else {
        hits.to_vec()
    }
}

/// 剩余名额。两者缺一就没有意义（教务不勾 `hasCount` 时不给这一对）。
fn remaining(l: &CourseSelectLesson) -> Option<i64> {
    match (l.std_count, l.limit_count) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    }
}

fn is_full(l: &CourseSelectLesson) -> bool {
    remaining(l).map(|r| r <= 0).unwrap_or(false)
}

/// 抢课语义的排序键（**升序**，越小越该先抢）：
/// 已选过的沉底 → **精确指定了老师的在前** → 匹配分高 → 有空位的在前 → 剩余名额多 → id 稳定兜底。
///
/// **分在空位之前**，这条是踩出来的：查「张玮」（张伟打错一个字）时，
/// 张伟明那个班碰巧还有余量、张伟那个班满了 —— 若按「有空位的先出手」，
/// 引擎会先去抢**另一位老师**的班。一个错字不该让目标换人；
/// 只有当两边的匹配度分不出高下时（比如同一门课的两个班），才轮到空位说话。
fn rank_key(h: &LessonHit) -> (u8, u8, i32, u8, i64, String) {
    (
        u8::from(h.lesson.selected_lesson.is_some()),
        u8::from(!h.hard),
        -h.score,
        u8::from(is_full(&h.lesson)),
        -remaining(&h.lesson).unwrap_or(-1),
        id_text(&h.lesson.id),
    )
}

/// 课程名（中文优先，退化到英文）。
pub fn course_name_of(l: &CourseSelectLesson) -> Option<String> {
    let c = l.course.as_ref()?;
    [c.name_zh.clone(), c.name_en.clone()]
        .into_iter()
        .flatten()
        .find(|s| !s.trim().is_empty())
}

/// 教师名（逐个）—— 教务给的是对象数组，见过 `nameZh` 与 `person.nameZh` 两种形状。
pub fn teacher_names(l: &CourseSelectLesson) -> Vec<String> {
    l.teachers
        .iter()
        .filter_map(|t| {
            t.get("nameZh")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    t.get("person")
                        .and_then(|p| p.get("nameZh"))
                        .and_then(|v| v.as_str())
                })
                .map(str::to_string)
        })
        .collect()
}

/// 教师名的展示文本（多个用顿号连起来）。
pub fn teacher_text(l: &CourseSelectLesson) -> Option<String> {
    let names = teacher_names(l);
    (!names.is_empty()).then(|| names.join("、"))
}

/// 命中 → 界面形状（计划候选清单里的一行）。
pub fn to_match(h: &LessonHit) -> GrabMatch {
    let l = &h.lesson;
    GrabMatch {
        lesson_id: l.id.clone(),
        course_name: course_name_of(l),
        course_code: l.course.as_ref().and_then(|c| c.code.clone()),
        teacher: teacher_text(l),
        std_count: l.std_count,
        limit_count: l.limit_count,
        picked: l.selected_lesson.is_some(),
        fields: h.fields.iter().map(|f| f.to_string()).collect(),
    }
}

/// 把一批教学班按一句查询排序筛出来。
///
/// **空查询返回空列表**（而不是全部）：调用方是「计划解析」与「输入预览」，
/// 两者都只在该有结果的时候要结果；返回全量只会让一个空输入看起来像「匹配到 200 个班」。
pub fn match_lessons(query: &str, lessons: &[CourseSelectLesson]) -> Vec<LessonHit> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .map(|t| normalize(t))
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<LessonHit> = lessons
        .iter()
        .filter_map(|l| {
            let fields = fields_of(l);
            let (score, used, hard) = hit_of(&fields, &tokens)?;
            Some(LessonHit {
                // 命中的字段按权重降序（fields_of 本来就是那个顺序，去重后仍保持）
                fields: used,
                score,
                hard,
                lesson: l.clone(),
            })
        })
        .collect();
    hits.sort_by(|a, b| rank_key(a).cmp(&rank_key(b)));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lesson(id: i64, code: &str, name: &str, teacher: Option<&str>, std: i64, limit: i64) -> CourseSelectLesson {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "course": { "id": id * 10, "code": code, "nameZh": name, "credits": 2 },
            "stdCount": std,
            "limitCount": limit,
            "teachers": teacher.map(|t| serde_json::json!({ "nameZh": t })).into_iter().collect::<Vec<_>>(),
            "scheduleGroups": [{ "id": id * 100, "no": 1, "dateTimePlace": { "text": "周一 第1-2节 5教101" } }],
        }))
        .unwrap()
    }

    fn demo() -> Vec<CourseSelectLesson> {
        vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 118, 120),
            lesson(2, "000001", "高等数学（上）", Some("李娜"), 60, 60),
            lesson(3, "000002", "大学英语（一）", Some("王芳"), 56, 60),
            lesson(4, "000031", "体育（一）", Some("赵强"), 30, 30),
        ]
    }

    fn names(hits: &[LessonHit]) -> Vec<String> {
        hits.iter()
            .map(|h| format!("{}-{}", h.lesson.id, h.lesson.course.as_ref().unwrap().code.clone().unwrap()))
            .collect()
    }

    #[test]
    fn finds_by_contiguous_substring_of_any_field() {
        let hits = match_lessons("英语", &demo());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].lesson.id, serde_json::json!(3));
        assert_eq!(hits[0].fields, vec![HIT_COURSE]);

        // 代码与教师也能搜。教师名打全了就是**精确命中**（见下面的「指定老师」那一组测试）
        assert_eq!(match_lessons("000031", &demo()).len(), 1);
        let by_teacher = match_lessons("赵强", &demo());
        assert_eq!(by_teacher.len(), 1);
        assert_eq!(by_teacher[0].fields, vec![HIT_TEACHER_EXACT]);
        // 只打一半（姓氏以外的部分）就退化成普通命中：不是指定，只是匹配上了
        let partial = match_lessons("赵", &demo());
        assert_eq!(partial[0].fields, vec![HIT_TEACHER]);
        assert!(!partial[0].hard);
        // 上课时间地点是低权重字段，但「搜周三」这种用法得能命中
        assert_eq!(match_lessons("周一", &demo()).len(), 4);
    }

    /// 「高数」是这套匹配存在的理由：课程全名里没有这两个字连在一起。
    #[test]
    fn scattered_subsequence_is_what_makes_it_fuzzy() {
        let hits = match_lessons("高数", &demo());
        assert_eq!(names(&hits), vec!["1-000001", "2-000001"], "只该匹配到高等数学的两个班");
        assert_eq!(hits[0].fields, vec![HIT_COURSE]);
        // 连名字都不沾边的不能因为「散落命中」被误收
        assert!(match_lessons("高英", &demo()).is_empty());
    }

    #[test]
    fn multiple_tokens_are_anded_and_may_land_on_different_fields() {
        // 一个词落在课程名、另一个落在教师名 —— 这正是「高数 张」该有的行为
        let hits = match_lessons("高数 张", &demo());
        assert_eq!(names(&hits), vec!["1-000001"]);
        assert!(hits[0].fields.contains(&HIT_COURSE));
        assert!(hits[0].fields.contains(&HIT_TEACHER));

        // 全角空格与半角空格一样切词
        assert_eq!(names(&match_lessons("高数\u{3000}李", &demo())), vec!["2-000001"]);
        // 任一词落空 = 整体不匹配
        assert!(match_lessons("高数 不存在", &demo()).is_empty());
    }

    /// 排序是抢课语义，不是相关性：**有名额的排满员的前面，选过的沉底**。
    #[test]
    fn ranking_prefers_what_can_actually_be_grabbed() {
        let hits = match_lessons("高等数学", &demo());
        assert_eq!(names(&hits), vec!["1-000001", "2-000001"], "有余量的教学班必须先出手");

        // 已经选上的沉到底：抢课引擎绝不该再对它动手
        let mut picked = demo();
        picked[0].selected_lesson = Some(serde_json::from_value(serde_json::json!({ "status": "已选中" })).unwrap());
        let hits = match_lessons("高等数学", &picked);
        assert_eq!(names(&hits), vec!["2-000001", "1-000001"]);
    }

    #[test]
    fn separator_variants_of_the_same_name_all_match() {
        // 三种写法指的是同一门课：半角括号、空格、全角括号
        let mut ls = demo();
        ls[0].course.as_mut().unwrap().name_zh = Some("大学英语(一)".into());
        ls[1].course.as_mut().unwrap().name_zh = Some("大学英语 一".into());
        assert_eq!(match_lessons("大学英语（一）", &ls).len(), 3);
        // 反向也成立：带空格的查询照样命中不带空格的课名
        assert_eq!(match_lessons("大学 英语", &ls).len(), 3);
    }

    #[test]
    fn empty_query_matches_nothing_and_missing_fields_do_not_panic() {
        assert!(match_lessons("", &demo()).is_empty());
        assert!(match_lessons("   \u{3000} ", &demo()).is_empty());

        // 教务缺字段时（真机上批次未开就是这样）不能整批挂掉
        let bare: CourseSelectLesson = serde_json::from_value(serde_json::json!({ "id": 7 })).unwrap();
        assert!(match_lessons("高数", &[bare]).is_empty());
        assert_eq!(id_text(&serde_json::json!(7)), "7");
        assert_eq!(id_text(&serde_json::json!("7")), "7");
    }

    /// 命中要能翻译成界面那一行：课名 / 代码 / 教师 / 名额 / 命中字段。
    /// 界面靠它显示「会抢哪些班」，所以缺字段时宁可少显示，不能整条挂掉。
    #[test]
    fn hit_translates_into_the_shape_the_ui_shows() {
        let hits = match_lessons("高数 张", &demo());
        let m = to_match(&hits[0]);
        assert_eq!(m.course_name.as_deref(), Some("高等数学（上）"));
        assert_eq!(m.course_code.as_deref(), Some("000001"));
        assert_eq!(m.teacher.as_deref(), Some("张伟"));
        assert_eq!((m.std_count, m.limit_count), (Some(118), Some(120)));
        assert!(!m.picked);
        assert_eq!(m.fields, vec![HIT_COURSE, HIT_TEACHER]);

        let bare: CourseSelectLesson = serde_json::from_value(serde_json::json!({ "id": 7 })).unwrap();
        assert!(course_name_of(&bare).is_none());
        assert!(teacher_text(&bare).is_none());
    }

    /* ─────────────── 指定老师：精确是「指定」，打错才是「模糊」 ─────────────── */

    /// 一份带「名字互相包含」的名单 —— 这是教师命中唯一真正难的地方：
    /// 张伟 ⊂ 张伟明。用户打全了名字，就该只抢那一位的班。
    fn named() -> Vec<CourseSelectLesson> {
        vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 118, 120),
            lesson(2, "000001", "高等数学（上）", Some("李娜"), 60, 60),
            lesson(3, "000003", "线性代数", Some("张伟明"), 40, 50),
            lesson(4, "000031", "体育（一）", Some("王芳"), 30, 30),
        ]
    }

    fn ids(hits: &[LessonHit]) -> Vec<i64> {
        hits.iter()
            .map(|h| h.lesson.id.as_i64().unwrap_or(-1))
            .collect()
    }

    /// **打全了教师名 = 指定**：`张伟` 只该抢张伟的班，
    /// 不该顺手把「张伟明」的班也拖进志愿组（抢到一门老师不对的课比没抢到更麻烦）。
    #[test]
    fn an_exact_teacher_name_is_a_specification_not_a_hint() {
        let hits = match_lessons("张伟", &named());
        assert_eq!(ids(&hits).len(), 2, "两条都算命中：一个全等、一个子串");
        assert!(hits[0].hard, "张伟 是精确命中");
        assert!(!hits[1].hard, "张伟明 只是子串命中，不是指定");
        assert_eq!(hits[0].fields, vec![HIT_TEACHER_EXACT]);
        assert_eq!(hits[1].fields, vec![HIT_TEACHER]);

        // 精确命中的排在前面，而且**只有它进入计划**
        assert_eq!(ids(&hits), vec![1, 3]);
        let pool = preferred(&hits);
        assert_eq!(ids(&pool), vec![1], "指定了老师就只抢他的班");

        // 课程名 + 教师名一起给，同样只留指定那位
        let hits = match_lessons("高数 张伟", &named());
        assert_eq!(ids(&preferred(&hits)), vec![1]);

        // 只打了姓：没有精确命中 → 两位张老师都算候选（谁来教都行）。
        // 顺序按「余量多的先出手」，所以这里只比集合，不比先后。
        let pool = preferred(&match_lessons("高数 张", &named()));
        assert_eq!(ids(&pool), vec![1], "另一位是李娜，不该被「张」捞进来");
        let mut pool_ids = ids(&preferred(&match_lessons("张", &named())));
        pool_ids.sort();
        assert_eq!(pool_ids, vec![1, 3], "只打姓氏时两位张老师都留着");
    }

    /// **名字打错 → 退回模糊匹配**：不独占、只是分数低一点，
    /// 但那个错字仍然要能把它命中（否则一门课都搜不到）。
    #[test]
    fn a_mistyped_teacher_name_falls_back_to_fuzzy() {
        // 张玮 → 张伟（姓对、差一个字）
        let hits = match_lessons("张玮", &named());
        assert_eq!(ids(&hits), vec![1, 3], "张伟 与 张伟明 都算「可能打错了」");
        assert!(hits.iter().all(|h| !h.hard), "近似命中**不是**指定");
        assert_eq!(hits[0].fields, vec![HIT_TEACHER_NEAR]);
        assert!(hits[0].score > hits[1].score, "名字长度对得上的排前面（张伟 先于 张伟明）");
        // 没有精确命中 → 不独占，两个都进候选
        assert_eq!(ids(&preferred(&hits)), vec![1, 3]);

        // 一个字的错字不该把整个查询打死：课程名那部分仍然照常命中
        let hits = match_lessons("高数 张玮", &named());
        assert_eq!(ids(&preferred(&hits)), vec![1], "只有张伟那条同时满足两个词");

        // 但姓氏必须对上 —— 否则「张伟」会命中「李伟」，那是两个人
        assert!(!match_lessons("张芳", &named()).iter().any(|h| h.hard || h.lesson.id == serde_json::json!(4)));
        assert!(match_lessons("王芳", &named()).iter().any(|h| h.hard), "全等就是全等");
    }

    /// **分在空位之前**：查「张玮」时，满员的「张伟」不能被有余量的「张伟明」
    /// 挤到后面 —— 那等于因为一个错字换了目标老师。满员是等得到的，认错人不是。
    #[test]
    fn a_better_name_match_goes_first_even_when_it_is_full() {
        let ls = vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 60, 60), // 满员，但名字更接近
            lesson(2, "000003", "线性代数", Some("张伟明"), 20, 60), // 有余量，但差一个字
        ];
        let hits = match_lessons("张玮", &ls);
        assert_eq!(ids(&hits), vec![1, 2], "更像的那位先出手，哪怕它是满的");
    }

    #[test]
    fn near_miss_needs_a_surname_and_at_least_two_chars() {
        // 差一个字：算
        assert!(near_miss_name("张伟", "张玮"));
        assert!(near_miss_name("张伟明", "张伟名"));
        // 只打姓氏（一个字）不算近似：它该走子串匹配，否则「张」会匹配到「李娜」
        assert!(!near_miss_name("张伟", "张"));
        // 姓氏不对不算
        assert!(!near_miss_name("李娜", "张娜"));
        assert!(!near_miss_name("张伟", "李伟"));
        // 差两个字（两个字的查询 = 全错）不算
        assert!(!near_miss_name("张伟", "李娜"));
    }

    /// 教师字段为空时不能因为「精确与否」判错：没有教师信息就是没命中，
    /// 不能把它当成「老师都对不上」而放行。
    #[test]
    fn missing_teacher_info_is_not_an_exact_hit() {
        let bare = vec![lesson(1, "000001", "高等数学（上）", None, 10, 20)];
        let hits = match_lessons("张伟", &bare);
        assert!(hits.is_empty(), "教务没给教师名时无从匹配，也不该给个空命中");
    }
}
