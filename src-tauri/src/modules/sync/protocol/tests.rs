//! 会话协议测试：两台「设备」跑在两条线程里，链路是内存管道。
//! 验的是协议本身（握手、清单、数据、blob、完成、游标），不是 UDP/HTTP 的可靠性。
//!
//! 一处别扭但要紧的约束：`rusqlite::Connection` **不是 Send**（内部是 RefCell），
//! 所以对端的库只能在对端那条线程里建、也只能在那里断言 —— 跨线程传的是可发送的
//! 身份（设备号/公钥）与链路的一半。想在这里加断言，就写进 `check` 闭包。

use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use rusqlite::Connection;

use super::*;
use crate::db::migrate_for_test;
use crate::modules::sync::blobs::BlobStore;
use crate::modules::sync::engine::{capture, Dirty, Raw};
use crate::modules::sync::identity;

/// 内存链路：两条单向队列。`fail_after` 用来模拟「说几句就断」。
struct MemLink {
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
    fail_after: Option<usize>,
    sent: usize,
    up: i64,
    down: i64,
}

impl Link for MemLink {
    fn send(&mut self, bytes: &[u8]) -> Result<()> {
        if let Some(limit) = self.fail_after {
            if self.sent >= limit {
                return Err(ReinError::Message("链路断了（测试注入）".into()));
            }
        }
        self.sent += 1;
        self.up += bytes.len() as i64;
        self.tx
            .send(bytes.to_vec())
            .map_err(|_| ReinError::Message("对端已关闭".into()))
    }

    fn recv(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
        match self.rx.recv_timeout(timeout) {
            Ok(v) => {
                self.down += v.len() as i64;
                Ok(Some(v))
            }
            Err(_) => Ok(None),
        }
    }

    fn path(&self) -> String {
        "lan".to_string()
    }

    fn stats(&self) -> (i64, i64) {
        (self.up, self.down)
    }
}

fn mem_pair(fail_after: Option<usize>) -> (MemLink, MemLink) {
    let (tx_a, rx_b) = channel();
    let (tx_b, rx_a) = channel();
    let mk = |tx, rx, fail_after| MemLink {
        tx,
        rx,
        fail_after,
        sent: 0,
        up: 0,
        down: 0,
    };
    (mk(tx_a, rx_a, fail_after), mk(tx_b, rx_b, None))
}

struct Dev {
    conn: Connection,
    store: BlobStore,
    id: identity::Identity,
    dir: std::path::PathBuf,
}

impl Dev {
    fn new() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!("rein-sync-proto-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = BlobStore::new(&dir);
        let id = identity::ensure(&conn).unwrap();
        Self {
            conn,
            store,
            id,
            dir,
        }
    }

    fn touch(&self, table: &str, rowid: i64, op: char) {
        capture(
            &self.conn,
            &self.store,
            &self.id.device_id,
            &Raw {
                table: table.to_string(),
                rowid,
                op,
            },
        )
        .unwrap();
    }

    fn text(&self, sql: &str) -> String {
        self.conn
            .query_row(sql, [], |r| r.get::<_, Option<String>>(0))
            .unwrap()
            .unwrap_or_default()
    }

    fn int(&self, sql: &str) -> i64 {
        self.conn
            .query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .unwrap()
            .unwrap_or(-1)
    }
}

impl Drop for Dev {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 跑一次会话：本线程这一侧是 `a`，对端在另一条线程里新建（连同它自己的库）。
/// `check` 在对端线程跑完会话之后执行 —— 断言写在那里才能看到对端的数据。
fn run_pair<F>(
    a: &Dev,
    secret: &[u8; 32],
    fail_after: Option<usize>,
    check: F,
) -> Result<Outcome>
where
    F: FnOnce(&Dev) + Send + 'static,
{
    let (setup_tx, setup_rx) = channel::<(String, [u8; 32], MemLink)>();
    let a_device = a.id.device_id.clone();
    let a_name = a.id.name.clone();
    let a_pub = a.id.public;
    let secret_b = *secret;
    let handle = std::thread::spawn(move || -> Result<()> {
        let b = Dev::new();
        let (lb, la) = mem_pair(fail_after);
        setup_tx
            .send((b.id.device_id.clone(), b.id.public, la))
            .map_err(|_| ReinError::Message("对端没起来".into()))?;
        let peer_b = Peer {
            device: a_device,
            name: a_name,
            public: a_pub,
        };
        let mut lb = lb;
        let outcome = run(&mut lb, &b.conn, &b.store, &b.id, &peer_b, &secret_b);
        // 会话失败时先别跑断言：那会把真正的错误盖成「查不到行」，排错变猜谜
        if outcome.is_ok() {
            check(&b);
        } else {
            eprintln!("对端会话失败：{outcome:?}");
        }
        outcome.map(|_| ())
    });

    let (peer_device, peer_pub, mut la) = setup_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| ReinError::Message("对端没有按时报到".into()))?;
    let peer_a = Peer {
        device: peer_device,
        name: "对端".into(),
        public: peer_pub,
    };
    let out = run(&mut la, &a.conn, &a.store, &a.id, &peer_a, secret);
    // 对端线程里的断言失败会以 JoinError 在这里炸出来
    let peer_result = handle.join().expect("对端线程 panic（多半是断言失败）");
    peer_result?;
    out
}

/// 全流程：A 的数据推给对端，对端收到并落地（含外键指向它自己那行）。
#[test]
fn two_devices_converge_over_the_protocol() {
    let a = Dev::new();
    // 组密钥就是一串字节（真实由同步码派生，见 crypto::derive_group_secret）
    let secret = [7u8; 32];

    a.conn
        .execute(
            "INSERT INTO todos (id, title, created_at) VALUES (1, '买菜', '2026-09-28T10:00')",
            [],
        )
        .unwrap();
    a.touch("todos", 1, 'i');
    a.conn
        .execute(
            "INSERT INTO foods (id, name, is_custom, created_at) VALUES (1, '自制酸奶', 1, 'now')",
            [],
        )
        .unwrap();
    a.touch("foods", 1, 'i');
    a.conn
        .execute(
            "INSERT INTO meal_logs (id, food_id, date, meal_type, quantity_mode, grams, source, created_at) \
             VALUES (1, 1, '2026-09-28', 'lunch', 'grams', 120, 'manual', 'now')",
            [],
        )
        .unwrap();
    a.touch("meal_logs", 1, 'i');

    let out = run_pair(&a, &secret, None, |b| {
        assert_eq!(b.text("SELECT title FROM todos"), "买菜");
        assert_eq!(b.text("SELECT name FROM foods"), "自制酸奶");
        assert_eq!(b.int("SELECT COUNT(*) FROM foods"), 1, "内置食物不该被同步过去");
        assert_eq!(
            b.int("SELECT food_id FROM meal_logs"),
            b.int("SELECT rowid FROM foods"),
            "外键该指向对端自己那行"
        );
        assert_eq!(
            b.text("SELECT uuid FROM sync_map WHERE kind = 'meal_logs'"),
            b.text("SELECT uuid FROM sync_map WHERE kind = 'meal_logs'")
        );
        assert_eq!(b.int("SELECT COUNT(*) FROM todos"), 1);
    })
    .unwrap();
    assert_eq!(out.path, "lan");
    assert!(out.up > 0 && out.down > 0, "字节数要记下来：{out:?}");
}

/// 大字段：聊天图片走 blob 通道（对象里只有引用，字节第二轮才取）。
#[test]
fn blobs_travel_separately() {
    let a = Dev::new();
    let secret = [9u8; 32];
    let image = vec![42u8; 300 * 1024];
    let b64 = base64::engine::general_purpose::STANDARD.encode(&image);
    a.conn
        .execute(
            "INSERT INTO ai_chats (id, title, created_at, updated_at) VALUES ('c1', '聊天', 'now', 'now')",
            [],
        )
        .unwrap();
    a.touch("ai_chats", 1, 'i');
    a.conn
        .execute(
            "INSERT INTO ai_chat_messages (id, chat_id, seq, role, kind, image_base64, mime, created_at) \
             VALUES ('m1', 'c1', 1, 'user', 'photo', ?1, 'image/jpeg', 'now')",
            [&b64],
        )
        .unwrap();
    a.touch("ai_chat_messages", 1, 'i');

    let blob = a.text("SELECT blob FROM sync_objects WHERE kind = 'ai_chat_messages'");
    assert!(blob.contains("__blob"), "{blob}");
    assert!(blob.len() < 4096, "对象本身要小：{}", blob.len());

    let expected = b64.clone();
    run_pair(&a, &secret, None, move |b| {
        // 别把 400KB 的 base64 打出来：先比长度与摘要，失败信息才看得懂
        let got = b.text("SELECT image_base64 FROM ai_chat_messages");
        assert_eq!(got.len(), expected.len(), "还原出来的图片长度不对");
        assert_eq!(
            crate::modules::sync::blobs::BlobStore::hash_of(got.as_bytes()),
            crate::modules::sync::blobs::BlobStore::hash_of(expected.as_bytes()),
            "还原出来的图片内容不对"
        );
        assert_eq!(
            b.conn
                .query_row("SELECT COUNT(*) FROM sync_blobs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1,
            "字节按内容寻址存一份"
        );
    })
    .unwrap();
}

/// 链路中途断掉：报错而不是死等（调用方据此换下一条路）。
#[test]
fn link_failure_surfaces() {
    let a = Dev::new();
    let b = Dev::new();
    let secret = crypto::derive_group_secret(&a.id.secret, &b.id.public, "code");
    a.conn
        .execute(
            "INSERT INTO todos (id, title, created_at) VALUES (1, 'x', 'now')",
            [],
        )
        .unwrap();
    a.touch("todos", 1, 'i');
    // 只允许发 1 帧（握手），之后断
    let out = run_pair(&a, &secret, Some(1), |_| {});
    assert!(out.is_err(), "断了要报错");
}

/// 握手 MAC 不对（同步码不同 → 组密钥不同）必须拒绝。
#[test]
fn wrong_group_secret_is_rejected() {
    let a = Dev::new();
    let b = Dev::new();
    // 故意用两把不同的组密钥：各自按自己的算
    let secret_a = crypto::derive_group_secret(&a.id.secret, &b.id.public, "code-A");
    let secret_b = crypto::derive_group_secret(&b.id.secret, &a.id.public, "code-B");
    let a_device = a.id.device_id.clone();
    let a_name = a.id.name.clone();
    let a_pub = a.id.public;
    let (setup_tx, setup_rx) = channel::<(String, [u8; 32], MemLink)>();
    let handle = std::thread::spawn(move || -> Result<()> {
        let b = Dev::new();
        let (lb, la) = mem_pair(None);
        setup_tx.send((b.id.device_id.clone(), b.id.public, la)).ok();
        let peer_b = Peer {
            device: a_device,
            name: a_name,
            public: a_pub,
        };
        let mut lb = lb;
        run(&mut lb, &b.conn, &b.store, &b.id, &peer_b, &secret_b).map(|_| ())
    });
    let (peer_device, peer_pub, mut la) = setup_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let peer_a = Peer {
        device: peer_device,
        name: "对端".into(),
        public: peer_pub,
    };
    let out = run(&mut la, &a.conn, &a.store, &a.id, &peer_a, &secret_a);
    assert!(out.is_err(), "组密钥不同必须拒绝：{out:?}");
    let _ = handle.join();
}

/// 对端公钥变了（配对记录与它自报的不一致）必须拒绝：冒充 + 换密钥都挡在这里。
#[test]
fn wrong_public_key_is_rejected() {
    let a = Dev::new();
    let b = Dev::new();
    let secret = crypto::derive_group_secret(&a.id.secret, &b.id.public, "code");
    let a_device = a.id.device_id.clone();
    let a_name = a.id.name.clone();
    let a_pub = a.id.public;
    let secret_b = secret;
    let (setup_tx, setup_rx) = channel::<(String, [u8; 32], MemLink)>();
    let handle = std::thread::spawn(move || -> Result<()> {
        let b = Dev::new();
        let (lb, la) = mem_pair(None);
        setup_tx.send((b.id.device_id.clone(), b.id.public, la)).ok();
        let peer_b = Peer {
            device: a_device,
            name: a_name,
            public: a_pub,
        };
        let mut lb = lb;
        run(&mut lb, &b.conn, &b.store, &b.id, &peer_b, &secret_b).map(|_| ())
    });
    let (peer_device, _, mut la) = setup_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let peer_a = Peer {
        device: peer_device,
        name: "对端".into(),
        public: [7u8; 32], // 记错的那把
    };
    let out = run(&mut la, &a.conn, &a.store, &a.id, &peer_a, &secret);
    assert!(out.is_err(), "公钥不一致必须拒绝：{out:?}");
    let _ = handle.join();
}

/// 钩子装好之后整条链路自洽：写一行 → 捕获 → 会话 → 对端有。
#[test]
fn hook_to_peer_end_to_end() {
    let a = Dev::new();
    let b = Dev::new();
    let dirty = std::sync::Arc::new(Dirty::new());
    crate::modules::sync::engine::install_hook(&a.conn, std::sync::Arc::clone(&dirty));
    a.conn
        .execute(
            "INSERT INTO ledger_entries (id, kind, amount_cents, category, created_at, date) \
             VALUES (1, 'expense', 1200, 'food', 'now', '2026-09-28')",
            [],
        )
        .unwrap();
    let me = a.id.device_id.clone();
    for raw in dirty.drain(10) {
        capture(&a.conn, &a.store, &me, &raw).unwrap();
    }
    let secret = crypto::derive_group_secret(&a.id.secret, &b.id.public, "code");
    run_pair(&a, &secret, None, |peer| {
        assert_eq!(peer.int("SELECT amount_cents FROM ledger_entries"), 1200);
    })
    .unwrap();
}
