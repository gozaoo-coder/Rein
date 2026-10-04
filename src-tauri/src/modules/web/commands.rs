//! web_fetch / web_search 命令 · 对应前端 `webService.ts`。
//!
//! 设计：ureq（轻量、可设 UA/超时）+ html2text（HTML→纯文本）。
//! 安全：仅 http/https；目标与**每一跳重定向**都过 SSRF 白名单（拒私网/环回/链路本地）；
//! 内容截断防上下文爆炸。
//!
//! 重定向为什么要自己跳（`redirects(0)`）：ureq 的自动跟随校验不了第二跳之后的地址，
//! 一条公网 URL 用 302 就能把我们带进内网。这里每一跳都重新过一遍 `validate_url`。

use std::io::{Cursor, Read};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;
use url::Url;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use crate::error::{ReinError, Result};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/// 单次抓取正文上限（4MB），防异常大页拖垮内存
const MAX_BYTES: u64 = 4 * 1024 * 1024;
/// 手动跟随重定向的最大跳数（每一跳都重新过 SSRF 校验）
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    /// 实际抓取到的最终地址（跟随重定向后）
    pub url: String,
    pub content_type: String,
    /// HTML 转纯文本后的正文（已按 max_chars 截断）
    pub text: String,
    pub truncated: bool,
    pub chars: usize,
}

fn is_private_v4(v4: Ipv4Addr) -> bool {
    let [a, b, c, _] = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || a == 0                                // 0.0.0.0/8「本网络」
        || (a == 100 && (64..128).contains(&b))  // 100.64/10 CGNAT（运营商共享地址）
        || (a == 192 && b == 0 && c == 0)        // 192.0.0.0/24 IETF 保留
        || (a == 198 && (18..20).contains(&b))   // 198.18/15 基准测试
        || a >= 240                              // 240/4 保留（含 255.255.255.255 广播）
}

fn v4_from_segments(hi: u16, lo: u16) -> Ipv4Addr {
    Ipv4Addr::new(
        (hi >> 8) as u8,
        (hi & 0xff) as u8,
        (lo >> 8) as u8,
        (lo & 0xff) as u8,
    )
}

fn is_private_v6(v6: Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
        return true;
    }
    let s = v6.segments();
    // ::ffff:a.b.c.d IPv4-mapped：从 v4 视角看就是本机/内网
    if s[..5] == [0, 0, 0, 0, 0] && s[5] == 0xffff {
        return is_private_v4(v4_from_segments(s[6], s[7]));
    }
    // 64:ff9b::/96 NAT64：DNS64 会把内网 v4 映射成这个前缀
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return is_private_v4(v4_from_segments(s[6], s[7]));
    }
    let first = s[0];
    // is_unique_local 稳定于 1.84（MSRV 1.77）：按 RFC 4193 手写 fc00::/7 判断
    (first & 0xfe00) == 0xfc00       // fc00::/7 唯一本地
        || (first & 0xffc0) == 0xfe80 // fe80::/10 链路本地
        || (first & 0xffc0) == 0xfec0 // fec0::/10 站点本地（已废弃，仍是内网语义）
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(*v4),
        IpAddr::V6(v6) => is_private_v6(*v6),
    }
}

/// SSRF 防护：仅 http/https，且目标（含域名解析出的**每一个**地址）不得为私网/环回。
///
/// 用 `Url::host()` 而不是 `host_str()`：后者对 IPv6 字面量带方括号（`[::1]`），
/// `parse::<IpAddr>()` 与 `to_socket_addrs()` 会双双落空 —— 那等于放行 `http://[::1]/`。
///
/// `pub(crate)`：教务救援面的公网请求也走这一关。那条路允许模型指定任意地址，
/// 但绝不允许它摸到本机与内网的任何服务 —— 这是「任意 URL」这个能力唯一不能让步的边界。
pub(crate) fn validate_url(raw: &str) -> Result<String> {
    let u = Url::parse(raw).map_err(|_| ReinError::Message(format!("URL 无效：{raw}")))?;
    let scheme = u.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ReinError::Message(format!(
            "仅支持 http/https 地址，收到：{scheme}"
        )));
    }
    match u.host() {
        Some(url::Host::Ipv4(v4)) => {
            if is_private_v4(v4) {
                return Err(ReinError::Message(format!("不允许访问内网地址：{v4}")));
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            if is_private_v6(v6) {
                return Err(ReinError::Message(format!("不允许访问内网地址：{v6}")));
            }
        }
        Some(url::Host::Domain(host)) => {
            // 解析失败一律拒绝（fail closed）：宁可回「解析不了」，也不能在未知地址上放行。
            let port = u.port_or_known_default().unwrap_or(80);
            let addrs = (host, port)
                .to_socket_addrs()
                .map_err(|e| ReinError::Message(format!("域名解析失败：{host}（{e}）")))?;
            for a in addrs {
                if is_private_ip(&a.ip()) {
                    return Err(ReinError::Message(format!("不允许访问内网地址：{host}")));
                }
            }
        }
        None => return Err(ReinError::Message(format!("URL 缺少主机名：{raw}"))),
    }
    Ok(u.to_string())
}

/// 发一跳请求。3xx/4xx/5xx 都算「拿到了响应」——抓取与诊断都需要看到正文，
/// 与 mock 侧（浏览器 fetch 不因状态码抛错）保持同一行为。
fn request_once(agent: &ureq::Agent, url: &str) -> Result<ureq::Response> {
    let outcome = agent
        .get(url)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .call();
    match outcome {
        Ok(r) => Ok(r),
        Err(ureq::Error::Status(_, r)) => Ok(r),
        Err(e) => Err(ReinError::Message(format!("网络请求失败：{e}"))),
    }
}

/// 逐跳跟完重定向（每一跳都重新过 SSRF 校验），返回最终地址与响应。
fn fetch_following_redirects(
    agent: &ureq::Agent,
    start: &str,
) -> Result<(String, ureq::Response)> {
    let mut current = validate_url(start)?;
    for _ in 0..=MAX_REDIRECTS {
        let resp = request_once(agent, &current)?;
        if (300..400).contains(&resp.status()) {
            if let Some(loc) = resp.header("location") {
                let next = Url::parse(&current)
                    .and_then(|base| base.join(loc))
                    .map_err(|e| ReinError::Message(format!("重定向地址无效：{loc}（{e}）")))?;
                current = validate_url(next.as_str())?;
                continue;
            }
        }
        return Ok((current, resp));
    }
    Err(ReinError::Message(format!(
        "重定向次数过多（超过 {MAX_REDIRECTS} 跳）：{start}"
    )))
}

/// 建一个抓取代理（超时 / UA / 手动跟重定向）
fn new_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .redirects(0)
        .build()
}

/// 抓取（含校验过的重定向）→ (最终地址, content-type, HTML)
fn fetch_html(raw_url: &str) -> Result<(String, String, String)> {
    let agent = new_agent();
    let (url, resp) = fetch_following_redirects(&agent, raw_url)?;
    let content_type = resp.header("content-type").unwrap_or("").to_string();
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_BYTES).read_to_end(&mut bytes)?;
    Ok((url, content_type, String::from_utf8_lossy(&bytes).to_string()))
}

/// 按上限截断，并给模型留一句「怎么拿更多」的提示
fn clip_text(plain: String, max_chars: usize) -> (String, bool, usize) {
    let chars = plain.chars().count();
    let truncated = chars > max_chars;
    let mut text: String = plain.chars().take(max_chars).collect();
    if truncated {
        text.push_str("\n\n…（内容已截断，如需更多请用更具体的关键词搜索或换更短的页面 URL）");
    }
    (text, truncated, chars)
}

/// 抓取 → HTML→纯文本 → 截断（web_fetch 用）
fn fetch_and_convert(raw_url: &str, max_chars: usize) -> Result<WebFetchResult> {
    let (url, content_type, html) = fetch_html(raw_url)?;
    let plain = html2text::from_read(Cursor::new(html.as_bytes()), 100)
        .map_err(|e| ReinError::Message(format!("网页转文本失败：{e}")))?;
    let (text, truncated, chars) = clip_text(plain, max_chars);
    Ok(WebFetchResult {
        url,
        content_type,
        text,
        truncated,
        chars,
    })
}

/* ---------------- 搜索结果结构化 ----------------
 * 搜索页整页转文本会掺进大量导航/广告噪音，而且结果链接常被必应包成
 * `…/ck/a?…&u=a1<base64url>` 这种跳转地址 —— 模型据此没法直接 web_fetch。
 * 这里把结果块抽成「标题 / 真实链接 / 摘要」，抽不到就回退整页转文本（见 web_search）。 */

/// 第一段 `<tag …>…</tag>` 的内容与结束位置（`from` 起找）
fn first_tag_inner<'a>(s: &'a str, tag: &str, from: usize) -> Option<(&'a str, usize)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = s.get(from..)?.find(&open)? + from;
    let body = s.get(start..)?.find('>')? + start + 1;
    let end = s.get(body..)?.find(&close)? + body;
    Some((&s[body..end], end))
}

/// 开标签 `<tag …>` 里某个属性的值
fn first_tag_attr(s: &str, tag: &str, attr: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = s.find(&open)? + open.len();
    let end = s.get(start..)?.find('>')? + start;
    let head = &s[start..end];
    let pat = format!("{attr}=\"");
    let v = head.find(&pat)? + pat.len();
    let ve = head.get(v..)?.find('"')? + v;
    Some(head[v..ve].to_string())
}

/// 片段 HTML → 单行纯文本（实体解码与标签剥离都交给 html2text）
fn fragment_text(frag: &str) -> String {
    let plain = html2text::from_read(Cursor::new(frag.as_bytes()), 200).unwrap_or_default();
    plain.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 必应的跳转链接（`…/ck/a?…&u=a1<base64url>`）解回真实地址；解不开就原样返回
fn real_link(href: &str) -> String {
    if !href.contains("/ck/a") {
        return href.to_string();
    }
    let Some((_, tail)) = href.split_once("u=a1") else {
        return href.to_string();
    };
    let b64: String = tail
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if b64.is_empty() {
        return href.to_string();
    }
    match URL_SAFE_NO_PAD.decode(b64.as_bytes()) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(u) if u.starts_with("http") => u,
            _ => href.to_string(),
        },
        Err(_) => href.to_string(),
    }
}

/// 结果页 → 「标题 / 链接 / 摘要」清单；一条都没抽到返回空串
fn extract_search_results(html: &str, limit: usize) -> String {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut from = 0usize;
    while out.len() < limit {
        // 认 `class="b_algo…` 前缀：必应偶尔把它写成 b_algo b_algoBigWiki 这类组合
        let Some(rel) = html[from..].find("class=\"b_algo") else {
            break;
        };
        let block_start = from + rel;
        let block_end = html[block_start..]
            .find("</li>")
            .map(|i| block_start + i)
            .unwrap_or(html.len());
        from = block_end;
        let block = &html[block_start..block_end];

        let Some((h2, h2_end)) = first_tag_inner(block, "h2", 0) else {
            continue;
        };
        let Some((anchor, _)) = first_tag_inner(h2, "a", 0) else {
            continue;
        };
        let Some(href) = first_tag_attr(h2, "a", "href") else {
            continue;
        };
        let title = fragment_text(anchor);
        let link = real_link(&href);
        if title.is_empty() || !link.starts_with("http") {
            continue;
        }
        if out.iter().any(|(_, l, _)| *l == link) {
            continue;
        }
        let snippet = first_tag_inner(block, "p", h2_end)
            .map(|(frag, _)| {
                let t = fragment_text(frag);
                t.chars().take(300).collect::<String>()
            })
            .unwrap_or_default();
        out.push((title, link, snippet));
    }
    let mut text = String::new();
    for (i, (title, link, snippet)) in out.iter().enumerate() {
        text.push_str(&format!("{}. {title}\n   {link}\n", i + 1));
        if !snippet.is_empty() {
            text.push_str(&format!("   {snippet}\n"));
        }
    }
    text
}

fn clamp_chars(v: Option<usize>) -> usize {
    v.unwrap_or(6000).clamp(500, 20000)
}

/// 抓取任意 http/https 页面并转纯文本（AI 用：看完搜索结果后读具体页）
#[tauri::command]
pub async fn web_fetch(url: String, max_chars: Option<usize>) -> Result<WebFetchResult> {
    let max = clamp_chars(max_chars);
    tauri::async_runtime::spawn_blocking(move || fetch_and_convert(&url, max))
        .await
        .map_err(|e| ReinError::Message(format!("网络任务执行失败：{e}")))?
}

/// 网络搜索（必应）：结果页抽成「标题 / 链接 / 摘要」，抽不到时回退整页转文本
#[tauri::command]
pub async fn web_search(query: String, max_chars: Option<usize>) -> Result<WebFetchResult> {
    let q = query.trim();
    if q.is_empty() {
        return Err(ReinError::Message("搜索关键词不能为空".into()));
    }
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", q)
        .append_pair("setmkt", "zh-CN")
        .append_pair("setlang", "zh-Hans")
        .finish();
    let url = format!("https://www.bing.com/search?{encoded}");
    let max = clamp_chars(max_chars);
    tauri::async_runtime::spawn_blocking(move || {
        let (final_url, content_type, html) = fetch_html(&url)?;
        let hits = extract_search_results(&html, 12);
        let plain = if hits.is_empty() {
            // 结构解析落空（必应改版等）：退回整页转文本，宁可噪音多也不能没有结果
            html2text::from_read(Cursor::new(html.as_bytes()), 100)
                .map_err(|e| ReinError::Message(format!("网页转文本失败：{e}")))?
        } else {
            format!("搜索结果（要读某条的正文，把它的链接交给 web_fetch）：\n{hits}")
        };
        let (text, truncated, chars) = clip_text(plain, max);
        Ok(WebFetchResult {
            url: final_url,
            content_type,
            text,
            truncated,
            chars,
        })
    })
    .await
    .map_err(|e| ReinError::Message(format!("网络任务执行失败：{e}")))?
}
