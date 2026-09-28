//! 本机身份：设备 id、名字、X25519 密钥对。
//!
//! 三样东西都落在 `sync_meta`：
//! - `device_id`：uuid v4，装完就不变（`short()` 取前 8 位给人看）；
//! - `device_name`：默认取个人档案里的昵称，可在设置页改；
//! - `x25519_sk` / `x25519_pub`：配对用的长期密钥（base64 的 32 字节）。
//!
//! 密钥生成只在这里发生一次：`ensure()` 幂等，缺什么补什么。私钥是明文存在
//! `rein.db` 里 —— 本机沙箱内其它应用读不到，但**不是**系统级密钥库；
//! 迁 Android Keystore 记在 `docs/SYNC.md` 的「已知限制」里。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::Result;

use super::{meta_get, meta_set};

const K_DEVICE_ID: &str = "device_id";
const K_DEVICE_NAME: &str = "device_name";
const K_SECRET: &str = "x25519_sk";
const K_PUBLIC: &str = "x25519_pub";

/// 本机身份。
pub struct Identity {
    pub device_id: String,
    pub name: String,
    pub secret: [u8; 32],
    pub public: [u8; 32],
}

/// 设备 id 的短形式：界面上认设备用它（完整 id 太长，也不必要）。
pub fn short(device_id: &str) -> String {
    device_id.chars().take(8).collect()
}

/// 公钥指纹：sha256 前 8 字节的 hex（16 个字符）。配对后两台设备互相核对它，
/// 确认「同步码那一头」确实是对方，而不是被谁撞上了码。
pub fn fingerprint(public: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public);
    let digest = hasher.finalize();
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// 默认设备名：个人档案里的昵称，没有就用平台与机型无关的兜底名。
fn default_name(conn: &Connection) -> String {
    conn.query_row("SELECT nickname FROM profile WHERE id = 1", [], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "Rein 设备".to_string())
}

/// 取本机身份；缺哪样补哪样（幂等）。返回当前生效的身份。
pub fn ensure(conn: &Connection) -> Result<Identity> {
    let device_id = match meta_get(conn, K_DEVICE_ID) {
        Some(v) if !v.is_empty() => v,
        _ => {
            let v = uuid::Uuid::new_v4().to_string();
            meta_set(conn, K_DEVICE_ID, &v)?;
            v
        }
    };

    let name = match meta_get(conn, K_DEVICE_NAME) {
        Some(v) if !v.trim().is_empty() => v,
        _ => {
            let v = default_name(conn);
            meta_set(conn, K_DEVICE_NAME, &v)?;
            v
        }
    };

    // 密钥对：只有两半都在才算数（只有一半的库 = 上次写到一半，重新生成一对，旧的作废）
    let secret = match (meta_get(conn, K_SECRET), meta_get(conn, K_PUBLIC)) {
        (Some(sk), Some(pk)) => match (decode32(&sk), decode32(&pk)) {
            (Some(sk), Some(pk)) => {
                let derived = PublicKey::from(&StaticSecret::from(sk)).to_bytes();
                // 公钥与私钥对不上（手改过库 / 写入被截断）时以私钥为准，重算公钥
                if derived == pk {
                    sk
                } else {
                    meta_set(conn, K_PUBLIC, &B64.encode(derived))?;
                    sk
                }
            }
            _ => gen_and_store(conn)?,
        },
        _ => gen_and_store(conn)?,
    };
    let public = PublicKey::from(&StaticSecret::from(secret)).to_bytes();

    Ok(Identity {
        device_id,
        name,
        secret,
        public,
    })
}

fn gen_and_store(conn: &Connection) -> Result<[u8; 32]> {
    let mut sk = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut sk);
    let pk = PublicKey::from(&StaticSecret::from(sk)).to_bytes();
    meta_set(conn, K_SECRET, &B64.encode(sk))?;
    meta_set(conn, K_PUBLIC, &B64.encode(pk))?;
    Ok(sk)
}

/// 公钥的 base64 解码（对端表里存的是字符串形式）。
pub fn decode_public(b64: &str) -> Option<[u8; 32]> {
    decode32(b64)
}

fn decode32(b64: &str) -> Option<[u8; 32]> {
    let raw = B64.decode(b64.trim()).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Some(out)
}

/// 改设备名（设置页用）。空名、超长、带换行的都不收。
pub fn set_name(conn: &Connection, name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(crate::error::ReinError::Message("设备名不能为空".into()));
    }
    if trimmed.chars().count() > 24 {
        return Err(crate::error::ReinError::Message(
            "设备名最多 24 个字".into(),
        ));
    }
    if trimmed.contains(['\n', '\r', '\t']) {
        return Err(crate::error::ReinError::Message("设备名不能含控制字符".into()));
    }
    meta_set(conn, K_DEVICE_NAME, trimmed)
}

/// X25519 ECDH：本机私钥 × 对端公钥。配对时两端各算一次，应得到同一个值。
pub fn shared_secret(secret: &[u8; 32], peer_public: &[u8; 32]) -> [u8; 32] {
    StaticSecret::from(*secret)
        .diffie_hellman(&PublicKey::from(*peer_public))
        .to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn ensure_is_idempotent() {
        let conn = db();
        let a = ensure(&conn).unwrap();
        let b = ensure(&conn).unwrap();
        assert_eq!(a.device_id, b.device_id);
        assert_eq!(a.secret, b.secret);
        assert_eq!(a.public, b.public);
        assert_eq!(a.name, b.name);
        assert_eq!(short(&a.device_id).len(), 8);
        assert_eq!(fingerprint(&a.public).len(), 16);
    }

    #[test]
    fn two_installs_get_different_identity() {
        let (a, b) = (db(), db());
        let ia = ensure(&a).unwrap();
        let ib = ensure(&b).unwrap();
        assert_ne!(ia.device_id, ib.device_id);
        assert_ne!(ia.public, ib.public);
    }

    /// 配对的核心等式：A 的私钥 × B 的公钥 == B 的私钥 × A 的公钥。
    #[test]
    fn ecdh_agrees() {
        let (ca, cb) = (db(), db());
        let a = ensure(&ca).unwrap();
        let b = ensure(&cb).unwrap();
        assert_eq!(
            shared_secret(&a.secret, &b.public),
            shared_secret(&b.secret, &a.public)
        );
    }

    /// 公钥被改坏时以私钥为准（重算公钥），而不是带着一对不匹配的密钥继续跑。
    #[test]
    fn repairs_broken_public_key() {
        let conn = db();
        let a = ensure(&conn).unwrap();
        meta_set(&conn, K_PUBLIC, &B64.encode([7u8; 32])).unwrap();
        let b = ensure(&conn).unwrap();
        assert_eq!(a.public, b.public);
        assert_eq!(a.secret, b.secret);
    }

    #[test]
    fn name_validation() {
        let conn = db();
        ensure(&conn).unwrap();
        assert!(set_name(&conn, "  我的手机  ").is_ok());
        assert_eq!(ensure(&conn).unwrap().name, "我的手机");
        assert!(set_name(&conn, "   ").is_err());
        assert!(set_name(&conn, &"长".repeat(25)).is_err());
        assert!(set_name(&conn, "a\nb").is_err());
    }

    /// 首次生成的名字取档案昵称（迁移里已经建好 id=1 那一行，所以用 upsert 改它）。
    #[test]
    fn default_name_uses_profile_nickname() {
        let conn = db();
        conn.execute(
            "INSERT INTO profile (id, nickname) VALUES (1, '小陈') \
             ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname",
            [],
        )
        .unwrap();
        assert_eq!(ensure(&conn).unwrap().name, "小陈");
    }
}
