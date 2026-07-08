//! 合并算法：Last-Write-Wins，软删除优先

use crate::sync::store::Record;

/// 将远端传入的 records 合并到本地 vec 中，返回是否发生变更
pub fn merge_into(local: &mut Vec<Record>, incoming: Vec<Record>) -> bool {
    let mut changed = false;
    for rec in incoming {
        match local.iter().position(|r| r.id == rec.id) {
            None => {
                local.push(rec);
                changed = true;
            }
            Some(idx) => {
                let existing = &mut local[idx];
                if rec.updated_at > existing.updated_at {
                    *existing = rec;
                    changed = true;
                }
            }
        }
    }
    changed
}

/// 单条增量变更合并
pub fn merge_one(local: &mut Vec<Record>, rec: Record) -> bool {
    match local.iter().position(|r| r.id == rec.id) {
        None => {
            local.push(rec);
            true
        }
        Some(idx) => {
            let existing = &mut local[idx];
            if rec.updated_at > existing.updated_at {
                *existing = rec;
                true
            } else {
                false
            }
        }
    }
}
