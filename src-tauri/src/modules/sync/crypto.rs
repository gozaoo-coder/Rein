//! 配对与端到端加密：X25519 换密钥 → HKDF 派生会话密钥 → ChaCha20-Poly1305 逐帧加密。
//!
//! ---------- 服务器看得到什么 ----------
//!
//! 只看得到两端的公钥与一串一次性的同步码（5 分钟过期、只在内存里）。组密钥由两端各自
// ECDH 算出来，从不经过网络；业务帧一律密文，中继那一档服务器也只是转发密文。
//! 中继走的是明文 HTTP（与更新链路一致，服务器没有 TLS），所以「端到端加密」不是锦上添花，
//! 而是这条链路能成立的前提。
//!
//! ---------- 密钥怎么来 ----------
//!
//! 1. 配对：两端交换公钥，各自 `X25519(自己的私钥, 对方的公钥)` —— 同一个值。
//!    HKDF-SHA256 用它 + 同步码派生出 `group_secret`（长期秘密，落 `sync_meta`）。
//! 2. 会话：两端各报一个随机 epoch，会话密钥 = `HKDF(group_secret, salt = 两个 epoch
//!    排序拼接, info = "rein-sync-v1")`，再按 epoch 的字典序分出**两个方向**的密钥 ——
//!    收发各用一把，避免两端的 nonce 撞车。
//! 3. 每帧：nonce = 该方向单调递增的计数器（96 位里放后 8 字节），AAD 绑帧头。
//!    计数器不重放、不该重复 —— 会话密钥每次会话都是新的，所以跨会话也不会重复用。
//!
//! ---------- 握手为什么要 MAC ----------
//!
//! 组密钥本身是共享秘密，但「对面到底是不是同组的那台设备」要证明：HELLO 里带一段
//! `HMAC(group_secret, "hello:" + device + epoch)`。谁都能重放一段旧 HELLO，但新的 epoch
//! 只有真持有组密钥的一方签得出来。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use hmac::Mac;
use sha2::Sha256;

use crate::error::{ReinError, Result};

type HmacSha256 = hmac::Hmac<Sha256>;

/// 从同步码与 ECDH 结果派生长期组密钥。
///
/// 同步码本身熵不高（人读的一串），所以它只当 **salt**：真正的秘密来自 ECDH，
/// 攻击者要拿到它得先解开一次 Diffie-Hellman，而不是猜那串码。
pub fn derive_group_secret(
    our_secret: &[u8; 32],
    peer_public: &[u8; 32],
    code: &str,
) -> [u8; 32] {
    let shared = super::identity::shared_secret(our_secret, peer_public);
    let hk = Hkdf::<Sha256>::new(Some(code.as_bytes()), &shared);
    let mut out = [0u8; 32];
    // expand 只在长度超 255*hash 时失败，32 字节不可能失败
    hk.expand(b"rein-sync-group-v1", &mut out)
        .expect("32 字节的 HKDF 输出不会失败");
    out
}

/// 两个方向各一把会话密钥 + 各自的发送计数器。
pub struct SessionCrypto {
    send_key: [u8; 32],
    recv_key: [u8; 32],
    send_counter: u64,
    recv_counter: u64,
    /// 只用于日志与断言：这一端是 epoch 较小的那一侧吗
    pub is_lower: bool,
}

impl SessionCrypto {
    /// `my_epoch` / `peer_epoch` 是本次会话两端各报的随机数。
    /// 按字典序排开，两端对「谁用哪把钥匙」的结论一致。
    pub fn new(secret: &[u8; 32], my_epoch: &[u8; 4], peer_epoch: &[u8; 4]) -> Self {
        let (low, high, is_lower) = if my_epoch <= peer_epoch {
            (my_epoch, peer_epoch, true)
        } else {
            (peer_epoch, my_epoch, false)
        };
        let mut salt = [0u8; 8];
        salt[..4].copy_from_slice(low);
        salt[4..].copy_from_slice(high);
        let hk = Hkdf::<Sha256>::new(Some(&salt), secret);
        let mut k_low = [0u8; 32];
        let mut k_high = [0u8; 32];
        hk.expand(b"rein-sync-v1:low->high", &mut k_low).unwrap();
        hk.expand(b"rein-sync-v1:high->low", &mut k_high).unwrap();
        // 低的一方发 k_low、收 k_high；高的一方反过来
        let (send_key, recv_key) = if is_lower {
            (k_low, k_high)
        } else {
            (k_high, k_low)
        };
        Self {
            send_key,
            recv_key,
            send_counter: 0,
            recv_counter: 0,
            is_lower,
        }
    }

    pub fn seal(&mut self, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
        let counter = self.send_counter;
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .ok_or_else(|| ReinError::Message("会话计数器溢出".into()))?;
        seal(&self.send_key, counter, aad, plain)
    }

    pub fn open(&mut self, aad: &[u8], cipher: &[u8]) -> Result<Vec<u8>> {
        let counter = self.recv_counter;
        let plain = open(&self.recv_key, counter, aad, cipher)?;
        self.recv_counter += 1;
        Ok(plain)
    }

    pub fn counters(&self) -> (u64, u64) {
        (self.send_counter, self.recv_counter)
    }
}

/// nonce：前 4 字节留零，后 8 字节是单调计数器（大端）。
fn nonce_of(counter: u64) -> Nonce {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&counter.to_be_bytes());
    *Nonce::from_slice(&bytes)
}

pub fn seal(key: &[u8; 32], counter: u64, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(
            &nonce_of(counter),
            Payload {
                msg: plain,
                aad,
            },
        )
        .map_err(|_| ReinError::Message("加密失败".into()))
}

pub fn open(key: &[u8; 32], counter: u64, aad: &[u8], cipher_text: &[u8]) -> Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            &nonce_of(counter),
            Payload {
                msg: cipher_text,
                aad,
            },
        )
        .map_err(|_| ReinError::Message("解密失败：密钥不对、计数不对，或帧被改过".into()))
}

/// 握手 MAC：证明对面持有组密钥（并绑上它自报的设备号与本次 epoch）。
pub fn hello_mac(secret: &[u8; 32], device: &str, epoch: &[u8; 4]) -> String {
    // 显式指定是 Mac 的 new_from_slice：aead 的 KeyInit 也有同名方法，不限定会歧义
    let mut mac = <HmacSha256 as hmac::Mac>::new_from_slice(secret).expect("HMAC 接受任意长度密钥");
    mac.update(b"hello:");
    mac.update(device.as_bytes());
    mac.update(b":");
    mac.update(epoch);
    B64.encode(hmac::Mac::finalize(mac).into_bytes())
}

pub fn hello_mac_ok(secret: &[u8; 32], device: &str, epoch: &[u8; 4], mac_b64: &str) -> bool {
    let expect = hello_mac(secret, device, epoch);
    // 定长比较，别让时间差泄漏前缀
    let a = expect.as_bytes();
    let b = mac_b64.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 随机 4 字节 epoch。
pub fn random_epoch() -> [u8; 4] {
    use rand::RngCore;
    let mut e = [0u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut e);
    e
}

/// 随机十六进制串（房间号等一次性标识用）。
pub fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn epoch_b64(epoch: &[u8; 4]) -> String {
    B64.encode(epoch)
}

pub fn epoch_from_b64(s: &str) -> Result<[u8; 4]> {
    let raw = B64
        .decode(s.trim())
        .map_err(|_| ReinError::Message("epoch 不是合法 base64".into()))?;
    if raw.len() != 4 {
        return Err(ReinError::Message("epoch 长度不对".into()));
    }
    let mut out = [0u8; 4];
    out.copy_from_slice(&raw);
    Ok(out)
}

pub fn secret_b64(secret: &[u8; 32]) -> String {
    B64.encode(secret)
}

pub fn secret_from_b64(s: &str) -> Result<[u8; 32]> {
    let raw = B64
        .decode(s.trim())
        .map_err(|_| ReinError::Message("组密钥不是合法 base64".into()))?;
    if raw.len() != 32 {
        return Err(ReinError::Message("组密钥长度不对".into()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn identity_pair() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32]) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        let a = super::super::identity::ensure(&conn).unwrap();
        let conn2 = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn2).unwrap();
        let b = super::super::identity::ensure(&conn2).unwrap();
        (a.secret, a.public, b.secret, b.public)
    }

    #[test]
    fn both_sides_derive_same_group_secret() {
        let (ask, apk, bsk, bpk) = identity_pair();
        assert_eq!(
            derive_group_secret(&ask, &bpk, "7K3-QP9"),
            derive_group_secret(&bsk, &apk, "7K3-QP9")
        );
        // 换一个同步码就完全是另一把密钥
        assert_ne!(
            derive_group_secret(&ask, &bpk, "7K3-QP9"),
            derive_group_secret(&ask, &bpk, "7K3-QP0")
        );
    }

    #[test]
    fn session_keys_are_directional_and_agree() {
        let secret = [9u8; 32];
        let ea = [1u8, 2, 3, 4];
        let eb = [9u8, 8, 7, 6];
        let mut a = SessionCrypto::new(&secret, &ea, &eb);
        let mut b = SessionCrypto::new(&secret, &eb, &ea);
        // A 发 B 收
        let cipher = a.seal(b"head", b"hello world").unwrap();
        assert_eq!(b.open(b"head", &cipher).unwrap(), b"hello world");
        // B 发 A 收（反方向用的是另一把钥匙）
        let cipher = b.seal(b"head", b"hi back").unwrap();
        assert_eq!(a.open(b"head", &cipher).unwrap(), b"hi back");
        assert_eq!(a.counters(), (1, 1));
        assert!(a.is_lower && !b.is_lower);
    }

    #[test]
    fn wrong_aad_or_counter_fails() {
        let secret = [3u8; 32];
        let mut a = SessionCrypto::new(&secret, &[1; 4], &[2; 4]);
        let cipher = a.seal(b"frame-header", b"payload").unwrap();
        let mut b = SessionCrypto::new(&secret, &[2; 4], &[1; 4]);
        assert!(b.open(b"other-header", &cipher).is_err(), "AAD 不同要拒");
        // 同一把钥匙、计数错位也要拒
        assert!(open(&[0u8; 32], 0, b"frame-header", &cipher).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let secret = [4u8; 32];
        let mut a = SessionCrypto::new(&secret, &[1; 4], &[2; 4]);
        let mut cipher = a.seal(b"h", b"payload").unwrap();
        cipher[0] ^= 0xff;
        let mut b = SessionCrypto::new(&secret, &[2; 4], &[1; 4]);
        assert!(b.open(b"h", &cipher).is_err());
    }

    #[test]
    fn hello_mac_binds_device_and_epoch() {
        let secret = [7u8; 32];
        let mac = hello_mac(&secret, "dev-a", &[1, 2, 3, 4]);
        assert!(hello_mac_ok(&secret, "dev-a", &[1, 2, 3, 4], &mac));
        assert!(!hello_mac_ok(&secret, "dev-b", &[1, 2, 3, 4], &mac), "换设备不认");
        assert!(!hello_mac_ok(&secret, "dev-a", &[1, 2, 3, 5], &mac), "重放旧 epoch 不认");
        assert!(!hello_mac_ok(&[8u8; 32], "dev-a", &[1, 2, 3, 4], &mac), "换密钥不认");
    }
}
