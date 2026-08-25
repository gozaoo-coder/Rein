# -*- coding: utf-8 -*-
"""
导入食物库种子数据 → resources/foods.json

数据来源与许可（2026-08 调研）：
1. 手写核心库（原 resources/foods.json 前 37 条，含份量）——保留原样、优先级最高。
2. 《中国食物成分表·标准版第 6 版》"能量和食物一般营养成分"转写集
   github.com/Sanotsu/china-food-composition-data（1,838 行 × 33 字段）。
   ⚠️ 权属不明（出版物转写），个人使用；商用前需替换或获得授权。
3. 台湾食药署《食品營養成分資料庫》镜像
   github.com/apoprotein-stack/nutric1688 food_data_a.csv（2,213 行 × 100+ 字段）。
   许可：政府資料開放授權條款（可商用，需署名"衛生福利部食品藥物管理署"）。

去重：繁转简 + 去括号内容后按名精确匹配；优先级 手写 > 第6版 > 台湾集。
字段：均折算为每 100g 可食部分；第6版缺糖/维D/B12/叶酸 → 0。
份量：外部数据无份量信息 → units=[]，记录时按克重。

用法：python scripts/import-foods.py  （源文件目录见 SRC_DIR）
"""
import csv
import glob
import json
import os
import re
import sys
from collections import Counter

from opencc import OpenCC

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.environ.get("FOOD_SRC", os.path.join(os.environ.get("TEMP", "/tmp"), "foodresearch"))
FOODS_JSON = os.path.join(REPO, "resources", "foods.json")
cc = OpenCC("t2s")


def norm(name: str) -> str:
    s = cc.convert(name or "")
    s = re.sub(r"[（(【\[].*?[）)】\]]", "", s)
    return re.sub(r"\s+", "", s).strip("·、，,。.-—~")


def num(v, nd=1) -> float:
    """'-'/''/异常 → 0；其余按小数位取整"""
    if v is None:
        return 0.0
    s = str(v).strip().replace(",", "")
    if not s or s in {"-", "—", "tr", "Tr", "N/A"}:
        return 0.0
    try:
        x = float(s)
    except ValueError:
        return 0.0
    if x != x or x < 0:  # NaN / 负值
        return 0.0
    return round(x, nd)


def entry(name, category, **kw) -> dict:
    e = {
        "name": name,
        "category": category,
        "defaultUnit": None,
        "units": [],
        "kcal": int(kw["kcal"]),
        "protein": num(kw.get("protein")),
        "carb": num(kw.get("carb")),
        "fat": num(kw.get("fat")),
        "fiber": num(kw.get("fiber")),
        "sugar": num(kw.get("sugar")),
        "sodiumMg": num(kw.get("sodiumMg")),
        "potassiumMg": num(kw.get("potassiumMg")),
        "calciumMg": num(kw.get("calciumMg")),
        "ironMg": num(kw.get("ironMg")),
        "zincMg": num(kw.get("zincMg")),
        "magnesiumMg": num(kw.get("magnesiumMg")),
        "vitAUg": num(kw.get("vitAUg")),
        "vitCMg": num(kw.get("vitCMg")),
        "vitDUg": num(kw.get("vitDUg")),
        "vitEMg": num(kw.get("vitEMg")),
        "vitB12Ug": num(kw.get("vitB12Ug")),
        "folateUg": num(kw.get("folateUg")),
    }
    return e


SC6_CAT = {
    "谷类及其制品": "主食", "薯类淀粉及其制品": "主食",
    "干豆类及其制品": "豆制品",
    "蔬菜类及其制品": "蔬菜", "菌藻类": "蔬菜",
    "水果类及其制品": "水果",
    "坚果种子类": "坚果",
    "畜肉类及其制品": "肉蛋", "禽肉类及其制品": "肉蛋", "蛋类及其制品": "肉蛋",
    "乳类及其制品": "奶类",
    "鱼虾蟹贝类": "水产",
    "植物油": "油脂", "动物油脂类": "油脂",
    "其他类": "其他",
}

TW_CAT = {
    "谷物类": "主食", "淀粉类": "主食",
    "豆类": "豆制品",
    "蔬菜类": "蔬菜", "菇类": "蔬菜", "藻类": "蔬菜",
    "水果类": "水果",
    "坚果及种子类": "坚果",
    "肉类": "肉蛋", "蛋类": "肉蛋",
    "乳品类": "奶类",
    "鱼贝类": "水产",
    "油脂类": "油脂",
    "饮料类": "饮品",
    "糕饼点心类": "零食", "糖类": "调味品",
    "调味料及香辛料类": "调味品",
    "加工调理食品及其他类": "加工食品",
}

def main():
    with open(FOODS_JSON, encoding="utf-8") as f:
        current = json.load(f)
    foods = list(current["foods"])
    seen = {norm(f["name"]) for f in foods}
    stats = Counter({"手写(保留)": len(foods)})

    # ---- 第6版转写集 ----
    for fp in sorted(glob.glob(os.path.join(SRC_DIR, "scc", "json_data", "*.json"))):
        cat_raw = os.path.basename(fp)[7:-5].rsplit("-", 1)[0]
        if cat_raw.startswith("婴幼儿食品"):
            continue
        category = SC6_CAT.get(cat_raw, "其他")
        for r in json.load(open(fp, encoding="utf-8")):
            name = (r.get("foodName") or "").strip()
            kcal = num(r.get("energyKCal"), 0)
            if not name or kcal <= 0 or norm(name) in seen:
                continue
            foods.append(entry(name, category,
                kcal=kcal, protein=r.get("protein"), carb=r.get("CHO"), fat=r.get("fat"),
                fiber=r.get("dietaryFiber"), sugar=0,
                sodiumMg=r.get("Na"), potassiumMg=r.get("K"), calciumMg=r.get("Ca"),
                ironMg=r.get("Fe"), zincMg=r.get("Zn"), magnesiumMg=r.get("Mg"),
                vitAUg=r.get("vitaminA"), vitCMg=r.get("vitaminC"), vitDUg=0,
                vitEMg=r.get("vitaminETotal"), vitB12Ug=0, folateUg=0))
            seen.add(norm(name))
            stats["第6版"] += 1

    # ---- 台湾食药署镜像 ----
    with open(os.path.join(SRC_DIR, "tw_food.csv"), encoding="utf-8", errors="replace") as f:
        for r in csv.DictReader(f):
            name = cc.convert((r.get("Food Name") or "").strip())
            kcal = num(r.get("Calorie (kcal)"), 0)
            if not name or kcal <= 0 or name.endswith("平均值") or norm(name) in seen:
                continue
            category = TW_CAT.get(cc.convert(r.get("Category") or ""), "其他")
            foods.append(entry(name, category,
                kcal=kcal, protein=r.get("Protein (g)"), carb=r.get("Carbs (g)"),
                fat=r.get("Fat (g)"), fiber=r.get("Fibre (g)"), sugar=r.get("Sugar (g)"),
                sodiumMg=r.get("Sodium (mg)"), potassiumMg=r.get("Potassium (mg)"),
                calciumMg=r.get("Calcium (mg)"), ironMg=r.get("Iron (mg)"),
                zincMg=r.get("Zinc (mg)"), magnesiumMg=r.get("Magnesium (mg)"),
                vitAUg=r.get("Vitamin A(RE) (ug)"), vitCMg=r.get("Vitamin C (mg)"),
                vitDUg=r.get("Vitamin D (ug)"), vitEMg=r.get("Vitamin E(α-TE) (mg)"),
                vitB12Ug=r.get("Vitamin B12 (ug)"), folateUg=r.get("Folic acid (ug)")))
            seen.add(norm(name))
            stats["台湾食药署"] += 1

    out = {
        "_attribution": "《中国食物成分表·标准版第6版》转写（个人使用）；台湾衛福部食藥署食品營養成分資料庫（政府資料開放授權條款，需署名）",
        "foods": foods,
    }
    with open(FOODS_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print("来源统计:", dict(stats), "总计:", len(foods))
    print("分类分布:", dict(Counter(f["category"] for f in foods)))
    size = os.path.getsize(FOODS_JSON)
    print(f"foods.json: {size/1024:.0f} KB")


if __name__ == "__main__":
    sys.exit(main())
