//! web_fetch / web_search 命令 · 对应前端 `webService.ts`。
//!
//! 设计：ureq（轻量、跟随重定向、可设 UA/超时）+ html2text（HTML→纯文本）。
//! 安全：仅 http/https、拦截私网/环回地址（SSRF 防护）；内容截断防上下文爆炸。

use std::io::{Cursor, Read};
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

use crate::error::{ReinError, Result};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/// 单次抓取正文上限（4MB），防异常大页拖垮内存
const MAX_BYTES: u64 = 4 * 1024 * 1024;

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

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
        }
        // is_unique_local 稳定于 1.84（MSRV 1.77）：按 RFC 4193 手写 fc00::/7 判断
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (u32::from(v6.segments()[0]) & 0xfe00) == 0xfc00
        }
    }
}

/// SSRF 防护：仅 http/https，且目标（含域名解析结果）不得为私网/环回地址
fn validate_url(raw: &str) -> Result<String> {
    let u = url::Url::parse(raw).map_err(|_| ReinError::Message(format!("URL 无效：{raw}")))?;
    let scheme = u.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ReinError::Message(format!("仅支持 http/https 地址，收到：{scheme}")));
    }
    let host = u
        .host_str()
        .ok_or_else(|| ReinError::Message("URL 缺少主机名".into()))?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_ip(&ip) {
            return Err(ReinError::Message(format!("不允许访问内网地址：{host}")));
        }
    } else if let Ok(addrs) = (host, 80).to_socket_addrs() {
        for a in addrs {
            if is_private_ip(&a.ip()) {
                return Err(ReinError::Message(format!("不允许访问内网地址：{host}")));
            }
        }
    }
    Ok(u.to_string())
}

/// 抓取 + HTML→纯文本 + 截断
fn fetch_and_convert(url: &str, max_chars: usize) -> Result<WebFetchResult> {
    let url = validate_url(url)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .redirects(6)
        .build();
    let req = agent
        .get(&url)
        .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    let resp = req
        .call()
        .map_err(|e| ReinError::Message(format!("网络请求失败：{e}")))?;
    let content_type = resp.header("content-type").unwrap_or("").to_string();
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)?;
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
