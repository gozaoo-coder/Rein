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
//! 在此之上有一条**放宽阶梯**（[`match_lessons_relaxed`]），但它的规矩很硬：
//! 严格匹配**一个都没命中**时才启用，而且**永远不丢「像教师名」的词** ——
//! 用户写了「张伟」而教务那儿没有张伟的班，那是「没找到」，不该退成「随便哪位老师的班」。
//! 抢错老师的课比没抢到更麻烦（还得去退），这条分寸比多命中几个班重要。
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
/// 命中**项目名**（`minorCourse`，体育课的「羽毛球」这类）。
/// 与 [`HIT_COURSE`] 分开报：学生要知道他是靠「项目名」命中的，
/// 而不是靠那门共用课程名（所有项目都叫「大学体育1」）。
pub const HIT_MINOR: &str = "minor";
/// 命中**教学班名称**（`lessonName`）—— 也就是「3院」「花江校区」「26级」这类限定词。
pub const HIT_LESSON: &str = "lesson";
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

/// **项目名**（`minorCourse`）与课程名同档。
///
/// 体育课是唯一必须这么做的例子，也是用户真实名单的写法：所有项目的课程名
/// 都叫「大学体育1」，学生嘴里的课名是「羽毛球」——那才是他要抢的东西。
/// 按弱字段给分，会让「羽毛球 3院」排不过随便一个沾边的班。
const W_MINOR: i32 = 100;

/// **教学班名称**（`lessonName`，如「大学体育1-花江校区-26级（3院、7院…）」）。
///
/// 院系 / 校区 / 年级这些**限定条件只写在这里**。给得比教师低一档：
/// 它是用来「收窄」而不是用来「指认」的 —— 写「3院」是为了别把发射浪费在
/// 选不了的班上，而不是因为「3院」是那门课的名字。
const W_LESSON: i32 = 70;

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
    /// 项目名（体育课的「羽毛球」这类）。**与课程名分开一个字段而不是并进去**：
    /// 命中标签要能分辨出来，界面上才说得清「你这是靠项目名命中的」。
    Minor(String),
    Code(String),
    /// 教师：既留逐个人名（精确/近似要靠它），也留拼接文本（通用打分要用）
    Teacher { names: Vec<String>, joined: String },
    /// 教学班名称：院系 / 校区 / 年级的唯一出处
    Lesson(String),
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
    // 项目名（体育课的「羽毛球」）：**与课程名同档**（W_MINOR = W_COURSE）。
    // 它才是学生嘴里的课名 —— 所有项目的课程名都是「大学体育1」。
    // （摆在代码之后纯粹是字段列举顺序，打分只看各自的权重）
    for name in [
        l.minor_course.as_ref().and_then(|c| c.name_zh.clone()),
        l.minor_course.as_ref().and_then(|c| c.name_en.clone()),
    ]
    .into_iter()
    .flatten()
    {
        if !name.trim().is_empty() {
            out.push(Field::Minor(name));
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
    // 教学班名称：院系 / 校区 / 年级的唯一出处（「3院」「花江校区」「26级」）
    if let Some(name) = l.lesson_name.as_ref() {
        if !name.trim().is_empty() {
            out.push(Field::Lesson(name.clone()));
        }
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
        Field::Minor(t) => (t.clone(), HIT_MINOR, W_MINOR),
        Field::Code(t) => (t.clone(), HIT_CODE, W_CODE),
        Field::Lesson(t) => (t.clone(), HIT_LESSON, W_LESSON),
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

/// 这句话命中的**课程**清单（按课程代码去重，保持「谁先值得出手」的顺序）。
///
/// 用来发现「一句话命中多门课」：同一门课在不同年级双开时是两个课程代码
/// （大一 `000004 大学体育1` / 大二 `000006 大学体育3`），课程名当然也能互相命中。
pub fn distinct_courses(hits: &[LessonHit]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for h in hits {
        let code = h
            .lesson
            .course
            .as_ref()
            .and_then(|c| c.code.clone())
            .unwrap_or_default();
        let code = code.trim().to_string();
        if code.is_empty() || out.iter().any(|(c, _)| *c == code) {
            continue;
        }
        let name = h
            .lesson
            .course
            .as_ref()
            .and_then(|c| c.name_zh.clone())
            .unwrap_or_default();
        out.push((code, name.trim().to_string()));
    }
    out
}

/// 这句查询是不是**跨课程**了 —— 只有「中一个就够」才会问这个问题。
///
/// 最危险的场景就是年级双开：用户只写项目名（「羽毛球」），而大一 / 大二各有一门，
/// 于是两边一起进志愿组 —— 引擎可能把**大二那门**抢回来，白费一次提交甚至选错课。
/// 所以跨课程时不该闷头排队，而该让人补上课程代码（`羽毛球 000004`）。
///
/// 查询里已经写死了某个课程代码时不算歧义：那一门课的代码就是唯一的那个，
/// `distinct_courses` 长度已经是 1（这条判断只是把意图写明白）。
pub fn ambiguous_courses(query: &str, hits: &[LessonHit]) -> Vec<(String, String)> {
    let codes = distinct_courses(hits);
    if codes.len() <= 1 {
        return Vec::new();
    }
    let tokens: Vec<String> = query.split_whitespace().map(normalize).collect();
    if codes.iter().any(|(c, _)| tokens.contains(&normalize(c))) {
        return Vec::new();
    }
    codes
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

/// 补齐名额之后**重排**一遍命中。
///
/// 排序键里的「有空位的先出手」依赖 `std_count`，而名单接口（`query-lesson`）
/// 在这套部署上**不回它** —— 名额是事后用 `std-count` 单独补上来的
/// （见 `models::StdCount`）。所以补完必须重排，否则那一步白做。
///
/// 与 [`match_lessons`] 用同一个 [`rank_key`]：两处要是各排各的，
/// 「预览里看到的顺序」与「真出手的顺序」就会不一样。
pub fn rerank(hits: &mut [LessonHit]) {
    hits.sort_by_key(rank_key);
}

/// 这个班**怎么和同门课的其他班区分开** —— 任务行上那一小段能分辨它的文字。
///
/// 体育课是必须这么做的例子：8 个项目的课程名**全都叫「大学体育1」**，
/// 任务行只写课程名的话，用户看着自己排的 8 条任务，认不出哪条是羽毛球。
///
/// 顺序是「项目名 → 教学班名称」：项目名最短最有辨识度（「羽毛球」）；
/// 没有项目名时退到教学班名称 —— 长，带院系/校区，但至少能把两个班分开。
pub fn distinct_label(l: &CourseSelectLesson) -> Option<String> {
    if let Some(m) = l.minor_course.as_ref() {
        for n in [m.name_zh.as_ref(), m.name_en.as_ref()].into_iter().flatten() {
            let t = n.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    l.lesson_name
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
        // 同门课的几个班**必须能被区分**：体育课 8 个班的课程名一模一样，
        // 预览里不写项目名，用户看到的是一列一样的「大学体育1」
        lesson_name: l.lesson_name.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        minor_name: l
            .minor_course
            .as_ref()
            .and_then(|c| c.name_zh.clone().or_else(|| c.name_en.clone()))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    }
}

/// 切词（同时归一化）——「高数 张伟」→ `["高数", "张伟"]`。
fn tokenize(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(normalize)
        .filter(|t| !t.is_empty())
        .collect()
}

/// 用指定的词表做一次**严格**匹配：[`hit_of`] 要求每个词都命中。
fn match_lessons_with(tokens: &[String], lessons: &[CourseSelectLesson]) -> Vec<LessonHit> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<LessonHit> = lessons
        .iter()
        .filter_map(|l| {
            let fields = fields_of(l);
            let (score, used, hard) = hit_of(&fields, tokens)?;
            Some(LessonHit {
                // 命中的字段按权重降序（fields_of 本来就是那个顺序，去重后仍保持）
                fields: used,
                score,
                hard,
                lesson: l.clone(),
            })
        })
        .collect();
    hits.sort_by_key(rank_key);
    hits
}

/// 这次结果是**怎么**匹配出来的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relax {
    /// 每个词都命中（默认档，最可信）
    Strict,
    /// 丢掉了「一个班都没命中」的死词（打错的代码、顺手写的时间）
    DropNoise,
    /// 还有活词但彼此对不上（「羽毛球 周四」——周四落在别的课上），丢掉了最不挑人的那个
    DropCommon,
}

impl Relax {
    /// 给界面/日志用的一句话。`None` 表示没放宽（严格命中）。
    pub fn note(self) -> Option<&'static str> {
        match self {
            Relax::Strict => None,
            Relax::DropNoise => Some("已放宽：忽略了名单里查不到的词"),
            Relax::DropCommon => Some("已放宽：忽略了太笼统的词"),
        }
    }
}

/// 放宽后的匹配结果。
pub struct RelaxedMatch {
    /// 命中（已按抢课语义排好序）
    pub hits: Vec<LessonHit>,
    /// 为了命中而**丢掉**的词（原样，未归一化）
    pub dropped: Vec<String>,
    pub level: Relax,
}

/// 一个词在整份名单里的落点：命中多少个班、命中在哪类字段上。
///
/// 「命中在哪类字段」是放宽时的**红线**：
///
/// - 课名 / 课程代码 / 教师 = **身份**，写了就是在指名道姓，一个都不能丢；
/// - 上课时间地点 = **偏好**，丢了只是「时间随缘」，课还是那门课。
struct Coverage {
    lessons: usize,
    /// 落在**课程名或代码**上 —— 这是「课还是那门课」的判据，见 [`keeps_the_course`]
    course: bool,
    identity: bool,
}

/// 逐个词算落点。`fields_of` 会被重复构造 —— 只在严格匹配扑空时才走这条路
/// （正常路径一次都不会到这里），所以不为此建索引。
fn coverage_of(tokens: &[String], lessons: &[CourseSelectLesson]) -> Vec<Coverage> {
    tokens
        .iter()
        .map(|token| {
            let mut c = Coverage {
                lessons: 0,
                course: false,
                identity: false,
            };
            for l in lessons {
                let fields = fields_of(l);
                let mut touched = false;
                for field in &fields {
                    let Some(h) = field_hit(field, token) else {
                        continue;
                    };
                    touched = true;
                    // 「认得出是哪门课」：课名、代码、**项目名**都算。
                    // 项目名必须算 —— 体育课里「羽毛球」就是那门课的名字，
                    // 不把它当身份，放宽时就会把「羽毛球」丢掉，去抢一门别的项目。
                    if matches!(h.tag, HIT_COURSE | HIT_CODE | HIT_MINOR) {
                        c.course = true;
                    }
                    // 「指名道姓」：课名 / 代码 / 教师 / 项目名 —— 放宽时一个都不动。
                    // 教学班名称（院系、校区）**刻意不在这一档**：
                    // 本院系的班用尽之后，本来就该放宽到别的院系
                    // （那些班服务端不一定让选，但总比一枪不发强）。
                    if matches!(
                        h.tag,
                        HIT_COURSE
                            | HIT_CODE
                            | HIT_MINOR
                            | HIT_TEACHER
                            | HIT_TEACHER_EXACT
                            | HIT_TEACHER_NEAR
                    ) {
                        c.identity = true;
                    }
                }
                if touched {
                    c.lessons += 1;
                }
            }
            c
        })
        .collect()
}

/// 丢掉那些词之后，**剩下的词还认不认得是哪门课**。
///
/// 这是「别换一门课」的最后一道闸：写「量子力学 张伟」而名单里没有量子力学时，
/// 丢掉「量子力学」确实能凑出结果 —— 但那个结果是**张伟的别的课**
/// （本次就是这么发现这条规则少了：端到端测试里它真去匹配了一门高等数学）。
/// 用户要的是「张伟的量子力学」，不是「张伟的任何一门课」。
///
/// 所以放宽的前提是：丢完之后，至少还有一个词落在**课程名或代码**上。
/// 「高数 无此条件」能放宽（高数还在），「量子力学 张伟」不能（只剩人名）。
fn keeps_the_course(tokens: &[String], lessons: &[CourseSelectLesson]) -> bool {
    coverage_of(tokens, lessons).iter().any(|c| c.course)
}

/// 名单里所有教师名（放宽时判断「这个词像不像人名」要用）。
fn all_teacher_names(lessons: &[CourseSelectLesson]) -> Vec<String> {
    lessons
        .iter()
        .flat_map(teacher_names)
        .map(|n| normalize(&n))
        .filter(|n| !n.is_empty())
        .collect()
}

/// 这个词**看着像不像一条硬约束**（人名 / 课程代码 / 名字长度）—— 像就不许丢。
///
/// 三条判据都是踩出来的：
///
/// - **课程代码的形状**（数字 + 字母数字）：写错一位就该是零命中。
///   已经有测试钉着这条（「大学体育1 000049」必须是零命中，不许退回按课名匹配）——
///   用户写代码就是为了钉死那一门课，丢了它等于换了门课。
/// - **人名形状**（2~3 个汉字）：教务上没这位老师，那是「没找到」，
///   不该退成「这门课随便哪位老师都行」。
/// - **跟某位老师差一个字**（[`looks_like_teacher`]）：「张玮」对不上「张伟」，
///   一看就是同一个人打错了 —— 这种词最不能丢。
fn looks_like_constraint(token: &str, names: &[String]) -> bool {
    let chars: Vec<char> = token.chars().collect();
    if chars.is_empty() {
        return true;
    }
    let code_shaped = chars.iter().all(|c| c.is_ascii_alphanumeric())
        && chars.iter().any(|c| c.is_ascii_digit());
    let name_shaped = chars.iter().all(|c| !c.is_ascii()) && (2..=3).contains(&chars.len());
    code_shaped || name_shaped || looks_like_teacher(token, names)
}

/// 这个词是不是「点名了某位老师」：前缀对上，或者跟某位老师只差一个字。
fn looks_like_teacher(token: &str, names: &[String]) -> bool {
    let q: Vec<char> = token.chars().collect();
    if q.is_empty() {
        return false;
    }
    names.iter().any(|n| {
        let nc: Vec<char> = n.chars().collect();
        // 前缀：只打姓、或名字打了一半
        (nc.len() >= q.len() && nc[..q.len()] == q[..]) || near_miss_name(n, token)
    })
}

/// 带**放宽阶梯**的匹配：严格命中不了就逐级退，退到哪一档、丢了哪些词都如实带回来。
///
/// 三条边界，都是刻意的：
///
/// 1. **严格档一旦有命中，永不放宽**。放宽只用来把「零结果」救成「有结果」，
///    不许把「已经对了的结果」换成更大的一坨。
/// 2. **不丢像教师名的词**（[`looks_like_teacher`]）。「张伟」查不到张伟的班，
///    这是「没找到」，不是「随便哪位老师都行」。
/// 3. 第二档只丢**一个**词，而且是最不挑人的那个（覆盖面最大）。丢掉最有辨识度的词
///    等于把用户真正指定的东西扔掉，那不叫放宽，那叫换一门课。
/// 4. **丢完之后必须还认得是哪门课**（[`keeps_the_course`]）：剩下的词里至少要有一个
///    落在课程名或代码上。写「量子力学 张伟」而名单里没有量子力学时，
///    丢掉「量子力学」能凑出结果 —— 但那是**张伟的别的课**。
///    这条是端到端测试逼出来的：它当时真去匹配了一门高等数学。
///
/// 丢词这件事必须被用户看见：返回的 `dropped` 会被写进日志与任务说明
/// （「已放宽：忽略了…」），预览里也会标出来。
///
/// **空查询返回空列表**（而不是全部）：调用方是「计划解析」与「输入预览」，
/// 两者都只在该有结果的时候要结果；返回全量只会让一个空输入看起来像「匹配到 200 个班」。
pub fn match_lessons_relaxed(query: &str, lessons: &[CourseSelectLesson]) -> RelaxedMatch {
    let raw = tokenize(query);
    let strict = match_lessons_with(&raw, lessons);
    if !strict.is_empty() || raw.len() < 2 {
        return RelaxedMatch {
            hits: strict,
            dropped: Vec::new(),
            level: Relax::Strict,
        };
    }

    let names = all_teacher_names(lessons);
    let cov = coverage_of(&raw, lessons);

    // 第一档：丢掉**一个班都没命中、又不像硬约束**的词（「第3周」「大学城校区」这类）。
    // 注意这里丢的都是**已经不成立**的条件：它一个班都没命中，本来就不可能被满足。
    let mut keep: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for (i, token) in raw.iter().enumerate() {
        if cov[i].lessons == 0 && !looks_like_constraint(token, &names) {
            dropped.push(token.clone());
        } else {
            keep.push(token.clone());
        }
    }
    if !dropped.is_empty() && !keep.is_empty() && keeps_the_course(&keep, lessons) {
        let hits = match_lessons_with(&keep, lessons);
        if !hits.is_empty() {
            return RelaxedMatch {
                hits,
                dropped,
                level: Relax::DropNoise,
            };
        }
    }

    // 第二档：剩下的词都命中过东西，但彼此对不上（「羽毛球 周四」——
    // 周四落在**别的**课的时间地点上，两个词的班没有交集）。
    // 只丢**纯时间地点**的词（身份词一个都不动），而且丢最不挑人的那个：
    // 它命中的班最多，说明它区分不出什么；真正要抢的那门课一定命中得最少，永远不会被丢。
    let live: Vec<usize> = (0..raw.len()).filter(|&i| cov[i].lessons > 0).collect();
    if live.len() >= 2 {
        let common = live
            .iter()
            .copied()
            .filter(|&i| !cov[i].identity)
            .max_by_key(|&i| cov[i].lessons);
        if let Some(i) = common {
            let keep2: Vec<String> = keep.iter().filter(|t| **t != raw[i]).cloned().collect();
            if !keep2.is_empty() && keeps_the_course(&keep2, lessons) {
                let hits = match_lessons_with(&keep2, lessons);
                if !hits.is_empty() {
                    let mut dropped = dropped;
                    dropped.push(raw[i].clone());
                    return RelaxedMatch {
                        hits,
                        dropped,
                        level: Relax::DropCommon,
                    };
                }
            }
        }
    }

    // 放宽不了就老实说放宽不了：宁可让计划卡片上写着「没匹配到」，
    // 也不要为了凑出一个结果去丢身份词（那等于替你换了一门课 / 换了个老师）。
    RelaxedMatch {
        hits: Vec::new(),
        dropped: Vec::new(),
        level: Relax::Strict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的匹配入口：走**完整**的放宽阶梯（和引擎、预览同一条路）。
    /// 绝大多数用例都该严格命中；放宽是另一件要单独钉的事
    /// （见「放宽阶梯」那一组测试，那里用 [`strict_only`] 直接问严格档）。
    fn matched(query: &str, lessons: &[CourseSelectLesson]) -> Vec<LessonHit> {
        match_lessons_relaxed(query, lessons).hits
    }

    /// **只问严格档**（不放宽）：用来钉「严格档命中不了」这类前提。
    fn strict_only(query: &str, lessons: &[CourseSelectLesson]) -> Vec<LessonHit> {
        match_lessons_with(&tokenize(query), lessons)
    }

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

    /// 大一 / 大二双开的体育课：两个课程代码、课名互相包含（真实数据里就是这样）
    fn two_grades() -> Vec<CourseSelectLesson> {
        vec![
            lesson(11, "000004", "大学体育1", Some("徐永峰"), 10, 40),
            lesson(12, "000006", "大学体育3", Some("徐永峰"), 5, 40),
        ]
    }

    /// **真实的体育课形状**（2026-09-20 实测，3 院大一）。
    ///
    /// 学生嘴里说的那门课，和教务字段里的那门课**不是同一个字符串**：
    ///   · 课程名 = 「大学体育1」（所有项目共用一个课程名）
    ///   · 项目名 = 「羽毛球」   → 在 `minorCourse.nameZh`（选课表格正是拿它当上标渲染）
    ///   · 班次名 = 「大学体育1-花江校区-26级（3院、7院、建交院）」→ 院系/校区只在这里
    ///
    /// 所以「写项目名即可命中」这件事，要求这两个字段**能进匹配**。
    fn pe_lessons() -> Vec<CourseSelectLesson> {
        let mk = |id: i64, lesson_name: &str, project: &str, teacher: &str| -> CourseSelectLesson {
            let mut l = lesson(id, "000004", "大学体育1", Some(teacher), 20, 41);
            l.lesson_name = Some(lesson_name.to_string());
            l.minor_course = Some(serde_json::from_value(serde_json::json!({ "nameZh": project })).unwrap());
            l
        };
        vec![
            mk(101, "大学体育1-花江校区-26级（3院、7院、建交院）", "羽毛球", "王秦丹青"),
            mk(102, "大学体育1-花江校区-26级（3院、7院、建交院）", "匹克球", "秦小鹏"),
            mk(103, "大学体育1-花江校区-26级（4院、5院）", "羽毛球", "周之昊"),
        ]
    }

    /// **体育课要按项目名抢，而不是按课程名** —— 这是用户真实名单的写法。
    ///
    /// 「羽毛球」在教务字段里既不是课程名（那是「大学体育1」）也不是教师，
    /// 它在 `minorCourse.nameZh`。这个字段不进匹配，写「羽毛球」就是零命中 ——
    /// 而用户真实的抢课目标恰恰是「大学体育1 的 8 个项目里挑一个」。
    #[test]
    fn pe_project_name_matches_via_minor_course() {
        let ls = pe_lessons();
        let hit = matched("羽毛球", &ls);
        assert_eq!(hit.len(), 2, "两个院系各有一个羽毛球班：{:?}", names(&hit));
        assert!(
            hit.iter().all(|h| h.fields.contains(&HIT_MINOR)),
            "它该如实报成「项目名」命中 —— 界面上要能看出是靠哪一项命中的：{:?}",
            hit.iter().map(|h| h.fields.clone()).collect::<Vec<_>>(),
        );
    }

    /// **院系/校区只写教学班名称里** —— 带上它是为了别把发射浪费在选不了的班上。
    #[test]
    fn pe_campus_keyword_matches_via_lesson_name() {
        let ls = pe_lessons();
        let hit = matched("羽毛球 3院", &ls);
        assert_eq!(names(&hit), vec!["101-000004"], "3 院那个羽毛球班：{:?}", names(&hit));

        let campus = matched("花江校区", &ls);
        assert_eq!(campus.len(), 3, "三个班都在花江校区：{:?}", names(&campus));
    }

    /// **写下的课程代码绝不放宽**。
    ///
    /// 这是「年级双开」那条危险的反面：查询里带了 `000004`，即使某个班里那门课
    /// 一个班都匹配不上，也**不能**退回去按课名匹配（否则会把大二的 `000006` 抢回来）。
    /// 命不中就是命不中 —— 交给上层 park 并说清楚。
    #[test]
    fn a_written_course_code_is_never_loosened() {
        let ls = two_grades();
        let hit = matched("大学体育1 000004", &ls);
        assert_eq!(names(&hit), vec!["11-000004"], "只该命中大一那门");

        // 代码写错一个字 → 零命中（不许拿课名去兜底）
        let none = matched("大学体育1 000049", &ls);
        assert!(none.is_empty(), "代码错了就该是零命中，不能退回按课名匹配");

        // 只写代码，同样只命中那一门
        assert_eq!(names(&matched("000006", &ls)), vec!["12-000006"]);
    }

    /// 年级双开：只写项目名会同时命中两个年级 —— 这正是要在排队前拦下来的情况。
    #[test]
    fn name_only_query_spanning_two_grades_is_flagged() {
        let ls = two_grades();
        let pool = matched("体育", &ls);
        assert_eq!(pool.len(), 2, "两个年级的班都会被这句命中");

        let amb = ambiguous_courses("体育", &pool);
        // 顺序跟随「谁该先出手」（余位多的在前），所以这里按集合比
        let mut got = amb.clone();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("000004".to_string(), "大学体育1".to_string()),
                ("000006".to_string(), "大学体育3".to_string()),
            ],
            "跨课程要按课程代码去重后报出来"
        );

        // 补上代码 → 不再是歧义（只剩一门课）
        let pinned = matched("体育 000004", &ls);
        assert!(ambiguous_courses("体育 000004", &pinned).is_empty());

        // 同一门课的多个教学班：代码相同，不算跨课程
        let same = vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 1, 2),
            lesson(2, "000001", "高等数学（上）", Some("李娜"), 1, 2),
        ];
        assert!(ambiguous_courses("高数", &matched("高数", &same)).is_empty());
    }

    /// 放宽阶梯：**严格档有命中就绝不放宽**。
    /// 放宽只用来把「零结果」救成「有结果」，不许把已经对了的结果换成更大的一坨。
    #[test]
    fn relaxation_never_widens_a_hit() {
        let ls = demo();
        let m = match_lessons_relaxed("英语", &ls);
        assert_eq!(m.level, Relax::Strict);
        assert!(m.dropped.is_empty());
        assert_eq!(m.hits.len(), 1);

        // 严格命中时，旁边的死词也不许丢 —— 放宽只在零命中时才允许发生
        for q in ["英语", "英语 赵强", "000031", "英语 李娜"] {
            let m = match_lessons_relaxed(q, &ls);
            if !strict_only(q, &ls).is_empty() {
                assert_eq!(m.level, Relax::Strict, "「{q}」严格档有命中，不该放宽");
                assert!(m.dropped.is_empty(), "「{q}」不该丢词");
            }
        }
    }

    /// 第一档：丢掉**一个班都没命中**的噪声词（它本来就无法被满足）。
    #[test]
    fn dead_noise_tokens_are_dropped_to_rescue_a_query() {
        let ls = demo();
        let m = match_lessons_relaxed("英语 大学城校区", &ls);
        assert_eq!(m.level, Relax::DropNoise, "死词该被丢掉");
        assert_eq!(m.dropped, vec!["大学城校区".to_string()]);
        assert_eq!(m.hits.len(), 1, "丢掉噪声后应当命中英语那一个班");

        // 丢掉的是「办不到的条件」，所以结果里不能出现别的课
        assert_eq!(m.hits[0].lesson.id, serde_json::json!(3));
    }

    /// **红线**：写了老师就是在指定人 —— 教务上没这位老师，那是「没找到」，
    /// 不该退成「这门课随便哪位老师都行」。
    #[test]
    fn a_name_shaped_token_is_never_dropped() {
        let ls = demo();
        // 「张伟」在名单里不存在（有的是「赵强」）
        let m = match_lessons_relaxed("英语 张伟", &ls);
        assert!(m.hits.is_empty(), "没有张伟的班，就该老实报没匹配到");
        assert!(m.dropped.is_empty(), "人名形状的词不许丢");

        // 打错一个字的人名：**近似命中**这条路本来就是为它准备的（张玮 → 张伟），
        // 所以它不该走到放宽那一步 —— 放宽的红线是「别丢掉这个人名」
        let with_zhang = vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 1, 2),
            lesson(2, "000002", "大学英语1", Some("李娜"), 1, 2),
        ];
        let m2 = match_lessons_relaxed("高等数学 张玮", &with_zhang);
        assert!(m2.dropped.is_empty(), "错字人名不许丢");
        assert_eq!(m2.level, Relax::Strict, "近似命中是严格档自己就能办的事");
        assert_eq!(m2.hits.len(), 1, "张玮 → 张伟 靠近似命中落到那个班上");
        assert!(
            !m2.hits[0].hard,
            "近似命中只加分、不独占（`hard` 专指「名字打全了」那种指定）"
        );
    }

    /// **红线**：放宽不许把「哪门课」丢掉。
    ///
    /// 写「量子力学 张伟」而名单里没有量子力学：丢掉课程名确实能凑出结果，
    /// 但那是**张伟的别的课**。用户要的不是「张伟的任何一门课」。
    /// （这条是端到端测试逼出来的：当时它真去匹配了一门高等数学。）
    #[test]
    fn a_dropped_course_name_must_not_turn_into_another_course() {
        let ls = vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 5, 60),
            lesson(2, "000001", "高等数学（上）", Some("李娜"), 5, 60),
        ];
        // 严格档：量子力学不在名单里 → 零命中
        assert!(strict_only("量子力学 张伟", &ls).is_empty());

        let m = match_lessons_relaxed("量子力学 张伟", &ls);
        assert!(
            m.hits.is_empty() && m.dropped.is_empty(),
            "丢掉课程名就只剩「张伟的任何一门课」了 —— 宁可说没找到"
        );
        assert_eq!(m.level, Relax::Strict, "不该放宽");

        // 而「课程在、噪声不在」是另一回事：课程还在，放宽是对的
        let ok = match_lessons_relaxed("高数 无此条件", &ls);
        assert_eq!(ok.level, Relax::DropNoise);
        assert_eq!(ok.dropped, vec!["无此条件".to_string()]);
        assert_eq!(ok.hits.len(), 2, "两门高等数学都还在候选里");
    }

    /// **红线**：课程代码写错一位 = 零命中，不许退回按课名匹配
    /// （既有测试 `wrong_code_is_not_a_fallback` 钉的就是这条分寸）。
    #[test]
    fn a_wrong_course_code_is_not_dropped() {
        let ls = vec![
            lesson(1, "000004", "大学体育1", Some("王强"), 5, 10),
            lesson(2, "000006", "大学体育3", Some("刘敏"), 5, 10),
        ];
        let m = match_lessons_relaxed("大学体育1 000049", &ls);
        assert!(m.hits.is_empty(), "代码错了就该是零命中");
        assert!(m.dropped.is_empty(), "代码形状的词不许丢");
    }

    /// 第二档：词都活着但彼此对不上时，丢掉**纯时间地点**的那个（它是偏好，不是身份）。
    #[test]
    fn a_place_only_token_can_be_dropped_when_nothing_intersects() {
        let mut a = lesson(1, "000004", "羽毛球（选项）", Some("王强"), 5, 10);
        let mut b = lesson(2, "000004", "羽毛球（选项）", Some("刘敏"), 5, 10);
        // 两个羽毛球班都在星期一；「星期四」只出现在另一门课的时间地点里 → 交集为空
        a.schedule_groups = vec![group("星期一 第3-4节 体育馆")];
        b.schedule_groups = vec![group("星期一 第7-8节 体育馆")];
        let c = {
            let mut c = lesson(3, "000009", "篮球（选项）", Some("赵强"), 5, 10);
            c.schedule_groups = vec![group("星期四 第3-4节 篮球场")];
            c
        };
        let ls = vec![a, b, c];

        let zero = strict_only("羽毛球 星期四", &ls);
        assert!(zero.is_empty(), "星期一的羽毛球班配上星期四，严格档应当零命中");
        // 「星期四」在篮球那个班的时间地点里 —— 它是**活词**（所以走第二档，而不是当死词丢掉）
        assert_eq!(
            strict_only("星期四", &ls).len(),
            1,
            "夹具本身要对：星期四得能命中篮球班的时间地点"
        );

        let m = match_lessons_relaxed("羽毛球 星期四", &ls);
        assert_eq!(m.level, Relax::DropCommon, "丢掉时间偏好后应当能命中");
        assert_eq!(m.dropped, vec!["星期四".to_string()]);
        assert_eq!(m.hits.len(), 2, "丢掉时间偏好后，两个羽毛球班都算命中");
        assert!(
            m.hits.iter().all(|h| h
                .lesson
                .course
                .as_ref()
                .unwrap()
                .code
                .as_deref()
                == Some("000004")),
            "放宽后不许把别的课（篮球）也算进来"
        );
    }

    /// 丢词**必须真的有用**才允许丢：救不回来就一个词都别动。
    #[test]
    fn dropping_a_token_must_actually_help() {
        let mut a = lesson(1, "000004", "羽毛球（选项）", Some("王强"), 5, 10);
        a.schedule_groups = vec![group("星期一 第1-2节 体育馆")];
        let b = {
            let mut b = lesson(2, "000009", "篮球（选项）", Some("赵强"), 5, 10);
            b.schedule_groups = vec![group("星期二 第3-4节 篮球场")];
            b
        };
        let ls = vec![a, b];

        // 羽毛球 + 两个只属于篮球班的时间地点词：丢掉任意一个都对不上羽毛球 → 一个都不许丢
        let m = match_lessons_relaxed("羽毛球 星期二 篮球场", &ls);
        assert!(m.dropped.is_empty(), "救不回来就不该丢词");
        assert!(m.hits.is_empty());
        assert_eq!(m.level, Relax::Strict, "没放宽就该是严格档");

        // 而丢一个就能命中时，才允许丢（同上一组测试的另一面）
        let m2 = match_lessons_relaxed("羽毛球 星期二", &ls);
        assert_eq!(m2.level, Relax::DropCommon);
        assert_eq!(m2.hits.len(), 1);
        assert_eq!(m2.dropped, vec!["星期二".to_string()]);
    }

    fn group(place: &str) -> super::super::models::ScheduleGroup {
        serde_json::from_value(serde_json::json!({
            "id": 1,
            "dateTimePlace": [{ "dateTime": place, "place": place }],
        }))
        .unwrap()
    }

    fn names(hits: &[LessonHit]) -> Vec<String> {
        hits.iter()
            .map(|h| format!("{}-{}", h.lesson.id, h.lesson.course.as_ref().unwrap().code.clone().unwrap()))
            .collect()
    }

    #[test]
    fn finds_by_contiguous_substring_of_any_field() {
        let hits = matched("英语", &demo());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].lesson.id, serde_json::json!(3));
        assert_eq!(hits[0].fields, vec![HIT_COURSE]);

        // 代码与教师也能搜。教师名打全了就是**精确命中**（见下面的「指定老师」那一组测试）
        assert_eq!(matched("000031", &demo()).len(), 1);
        let by_teacher = matched("赵强", &demo());
        assert_eq!(by_teacher.len(), 1);
        assert_eq!(by_teacher[0].fields, vec![HIT_TEACHER_EXACT]);
        // 只打一半（姓氏以外的部分）就退化成普通命中：不是指定，只是匹配上了
        let partial = matched("赵", &demo());
        assert_eq!(partial[0].fields, vec![HIT_TEACHER]);
        assert!(!partial[0].hard);
        // 上课时间地点是低权重字段，但「搜周三」这种用法得能命中
        assert_eq!(matched("周一", &demo()).len(), 4);
    }

    /// 「高数」是这套匹配存在的理由：课程全名里没有这两个字连在一起。
    #[test]
    fn scattered_subsequence_is_what_makes_it_fuzzy() {
        let hits = matched("高数", &demo());
        assert_eq!(names(&hits), vec!["1-000001", "2-000001"], "只该匹配到高等数学的两个班");
        assert_eq!(hits[0].fields, vec![HIT_COURSE]);
        // 连名字都不沾边的不能因为「散落命中」被误收
        assert!(matched("高英", &demo()).is_empty());
    }

    #[test]
    fn multiple_tokens_are_anded_and_may_land_on_different_fields() {
        // 一个词落在课程名、另一个落在教师名 —— 这正是「高数 张」该有的行为
        let hits = matched("高数 张", &demo());
        assert_eq!(names(&hits), vec!["1-000001"]);
        assert!(hits[0].fields.contains(&HIT_COURSE));
        assert!(hits[0].fields.contains(&HIT_TEACHER));

        // 全角空格与半角空格一样切词
        assert_eq!(names(&matched("高数\u{3000}李", &demo())), vec!["2-000001"]);
        // 任一词落空 = 整体不匹配
        assert!(matched("高数 不存在", &demo()).is_empty());
    }

    /// 排序是抢课语义，不是相关性：**有名额的排满员的前面，选过的沉底**。
    #[test]
    fn ranking_prefers_what_can_actually_be_grabbed() {
        let hits = matched("高等数学", &demo());
        assert_eq!(names(&hits), vec!["1-000001", "2-000001"], "有余量的教学班必须先出手");

        // 已经选上的沉到底：抢课引擎绝不该再对它动手
        let mut picked = demo();
        picked[0].selected_lesson = Some(serde_json::from_value(serde_json::json!({ "status": "已选中" })).unwrap());
        let hits = matched("高等数学", &picked);
        assert_eq!(names(&hits), vec!["2-000001", "1-000001"]);
    }

    #[test]
    fn separator_variants_of_the_same_name_all_match() {
        // 三种写法指的是同一门课：半角括号、空格、全角括号
        let mut ls = demo();
        ls[0].course.as_mut().unwrap().name_zh = Some("大学英语(一)".into());
        ls[1].course.as_mut().unwrap().name_zh = Some("大学英语 一".into());
        assert_eq!(matched("大学英语（一）", &ls).len(), 3);
        // 反向也成立：带空格的查询照样命中不带空格的课名
        assert_eq!(matched("大学 英语", &ls).len(), 3);
    }

    #[test]
    fn empty_query_matches_nothing_and_missing_fields_do_not_panic() {
        assert!(matched("", &demo()).is_empty());
        assert!(matched("   \u{3000} ", &demo()).is_empty());

        // 教务缺字段时（真机上批次未开就是这样）不能整批挂掉
        let bare: CourseSelectLesson = serde_json::from_value(serde_json::json!({ "id": 7 })).unwrap();
        assert!(matched("高数", &[bare]).is_empty());
        assert_eq!(id_text(&serde_json::json!(7)), "7");
        assert_eq!(id_text(&serde_json::json!("7")), "7");
    }

    /// 命中要能翻译成界面那一行：课名 / 代码 / 教师 / 名额 / 命中字段。
    /// 界面靠它显示「会抢哪些班」，所以缺字段时宁可少显示，不能整条挂掉。
    #[test]
    fn hit_translates_into_the_shape_the_ui_shows() {
        let hits = matched("高数 张", &demo());
        let m = to_match(&hits[0]);
        assert_eq!(m.course_name.as_deref(), Some("高等数学（上）"));
        assert_eq!(m.course_code.as_deref(), Some("000001"));
        assert_eq!(m.teacher.as_deref(), Some("张伟"));
        assert_eq!((m.std_count, m.limit_count), (Some(118), Some(120)));
        assert!(!m.picked);
        assert_eq!(m.fields, vec![HIT_COURSE, HIT_TEACHER]);
        // 普通课没有项目名/教学班名 —— 界面该拿到的是 None 而不是空串
        assert_eq!(m.minor_name, None);
        assert_eq!(m.lesson_name, None);

        let bare: CourseSelectLesson = serde_json::from_value(serde_json::json!({ "id": 7 })).unwrap();
        assert!(course_name_of(&bare).is_none());
        assert!(teacher_text(&bare).is_none());
        assert!(distinct_label(&bare).is_none());
    }

    /// **同门课的班要能被区分开**：体育课 8 个项目的课程名一模一样，
    /// 只给课程名的话，预览与任务行都是一列认不出来的「大学体育1」。
    #[test]
    fn a_minor_project_name_reaches_the_ui() {
        let ls = pe_lessons();
        let hit = matched("羽毛球 3院", &ls);
        let m = to_match(&hit[0]);
        assert_eq!(m.course_name.as_deref(), Some("大学体育1"), "课程名还是教务那个");
        assert_eq!(m.minor_name.as_deref(), Some("羽毛球"), "项目名要单独带出去");
        assert!(
            m.lesson_name.as_deref().unwrap_or("").contains("3院"),
            "教学班名要带出去（院系在里面）：{:?}",
            m.lesson_name,
        );

        // 任务行那一小段：项目名优先
        assert_eq!(distinct_label(&ls[0]).as_deref(), Some("羽毛球"));
        // 没有项目名时退到教学班名称（至少能区分）
        let mut plain = lesson(9, "000001", "高等数学（上）", Some("张伟"), 1, 2);
        plain.lesson_name = Some("高等数学（上）-01班".into());
        assert_eq!(distinct_label(&plain).as_deref(), Some("高等数学（上）-01班"));
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
        let hits = matched("张伟", &named());
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
        let hits = matched("高数 张伟", &named());
        assert_eq!(ids(&preferred(&hits)), vec![1]);

        // 只打了姓：没有精确命中 → 两位张老师都算候选（谁来教都行）。
        // 顺序按「余量多的先出手」，所以这里只比集合，不比先后。
        let pool = preferred(&matched("高数 张", &named()));
        assert_eq!(ids(&pool), vec![1], "另一位是李娜，不该被「张」捞进来");
        let mut pool_ids = ids(&preferred(&matched("张", &named())));
        pool_ids.sort();
        assert_eq!(pool_ids, vec![1, 3], "只打姓氏时两位张老师都留着");
    }

    /// **名字打错 → 退回模糊匹配**：不独占、只是分数低一点，
    /// 但那个错字仍然要能把它命中（否则一门课都搜不到）。
    #[test]
    fn a_mistyped_teacher_name_falls_back_to_fuzzy() {
        // 张玮 → 张伟（姓对、差一个字）
        let hits = matched("张玮", &named());
        assert_eq!(ids(&hits), vec![1, 3], "张伟 与 张伟明 都算「可能打错了」");
        assert!(hits.iter().all(|h| !h.hard), "近似命中**不是**指定");
        assert_eq!(hits[0].fields, vec![HIT_TEACHER_NEAR]);
        assert!(hits[0].score > hits[1].score, "名字长度对得上的排前面（张伟 先于 张伟明）");
        // 没有精确命中 → 不独占，两个都进候选
        assert_eq!(ids(&preferred(&hits)), vec![1, 3]);

        // 一个字的错字不该把整个查询打死：课程名那部分仍然照常命中
        let hits = matched("高数 张玮", &named());
        assert_eq!(ids(&preferred(&hits)), vec![1], "只有张伟那条同时满足两个词");

        // 但姓氏必须对上 —— 否则「张伟」会命中「李伟」，那是两个人
        assert!(!matched("张芳", &named()).iter().any(|h| h.hard || h.lesson.id == serde_json::json!(4)));
        assert!(matched("王芳", &named()).iter().any(|h| h.hard), "全等就是全等");
    }

    /// **分在空位之前**：查「张玮」时，满员的「张伟」不能被有余量的「张伟明」
    /// 挤到后面 —— 那等于因为一个错字换了目标老师。满员是等得到的，认错人不是。
    #[test]
    fn a_better_name_match_goes_first_even_when_it_is_full() {
        let ls = vec![
            lesson(1, "000001", "高等数学（上）", Some("张伟"), 60, 60), // 满员，但名字更接近
            lesson(2, "000003", "线性代数", Some("张伟明"), 20, 60), // 有余量，但差一个字
        ];
        let hits = matched("张玮", &ls);
        assert_eq!(ids(&hits), vec![1, 2], "更像的那位先出手，哪怕它是满的");
    }

    /// 补完名额要**重排**：满员的班必须沉到有名额的后面去。
    ///
    /// 真机上 `query-lesson` 不回 `stdCount`，名额是事后用 `std-count` 补的
    /// （见 `grab::fill_seats`）—— 补完不重排，这一步等于白做。
    #[test]
    fn seats_arriving_late_trigger_a_rerank() {
        // 名单里两个班都没带名额（真机上 query-lesson 就是这样）
        let mut a = lesson(1, "000001", "高等数学（上）", Some("张伟"), 0, 60);
        let mut b = lesson(2, "000001", "高等数学（上）", Some("李娜"), 0, 60);
        a.std_count = None;
        b.std_count = None;
        let mut hits = matched("高等数学", &[a, b]);
        assert_eq!(ids(&hits), vec![1, 2], "没有名额信息时按 id 稳定排序");

        // `std-count` 事后补上：1 号满员、2 号还有余量
        hits[0].lesson.std_count = Some(60);
        hits[1].lesson.std_count = Some(1);
        rerank(&mut hits);
        assert_eq!(ids(&hits), vec![2, 1], "补完名额要重排：有名额的先出手");
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
        let hits = matched("张伟", &bare);
        assert!(hits.is_empty(), "教务没给教师名时无从匹配，也不该给个空命中");
    }
}
