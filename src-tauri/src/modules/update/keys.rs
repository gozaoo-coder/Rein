//! 更新签名公钥（由 `node scripts/release/keygen.mjs` 生成，改动此文件等于更换信任根）。
//!
//! 格式：base64(minisign 公钥文件全文)，与 tauri-plugin-updater 的 pubkey 配置一致。
//! 客户端只认这把钥匙签出来的安装包 —— 服务器被拿下也推不出能装上的更新。

pub const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZFRUVCQjUxNjY0NjMyNTkKUldSWk1rWm1VYnZ1L2hNY2VVV2JZOU8zSWZ4RnNXQ2M3ZlBYM2VKZkpqeTNtWUxWaDZZM3liYWkK";
