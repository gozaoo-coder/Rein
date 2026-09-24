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

/// 抓取（含校验过的重定向）→ HTML→纯文本 → 截断
fn fetch_and_convert(raw_url: &str, max_chars: usize) -> Result<WebFetchResult> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .redirects(0)
        .build();
    let (url, resp) = fetch_following_redirects(&agent, raw_url)?;
    let content_type = resp.header("content-type").unwrap_or("").to_string();
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_BYTES).read_to_end(&mut bytes)?;
    let html = String::from_utf8_lossy(&bytes).to_string();

    let plain = html2text::from_read(Cursor::new(html.as_bytes()), 100)
        .map_err(|e| ReinError::Message(format!("网页转文本失败：{e}")))?;
    let chars = plain.chars().count();
    let truncated = chars > max_chars;
    let mut text: String = plain.chars().take(max_chars).collect();
    if truncated {
        text.push_str("\n\n…（内容已截断，如需更多请用更具体的关键词搜索或换更短的页面 URL）");
    }
    Ok(WebFetchResult {
        url,
        content_type,
        text,
        truncated,
        chars,
    })
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

/// 网络搜索（默认必应）：拼搜索 URL 后走同一抓取管道
#[tauri::command]
pub async fn web_search(query: String, max_chars: Option<usize>) -> Result<WebFetchResult> {
    let q = query.trim();
    if q.is_empty() {
        return Err(ReinError::Message("搜索关键词不能为空".into()));
    }
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", q)
        .finish();
    let url = format!("https://www.bing.com/search?{encoded}");
    let max = clamp_chars(max_chars);
    tauri::async_runtime::spawn_blocking(move || fetch_and_convert(&url, max))
        .await
        .map_err(|e| ReinError::Message(format!("网络任务执行失败：{e}")))?
}
