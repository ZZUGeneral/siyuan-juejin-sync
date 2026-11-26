---
title: 文件、路径与序列化
date: 2026-11-24T16:14:47+08:00
lastmod: 2026-11-24T16:15:53+08:00
---

---

## 5.3 JSON / YAML / TOML 处理

![image](assets/image-20261124161531-ag7m6zn.png)

### 5.3.1 JSON：机器交互的标准

```python
import json

data = {
    "name": "llm-demo",
    "version": "0.1.0",
    "dependencies": ["httpx", "pydantic"],
    "config": {"timeout": 30, "retries": 3},
    "enabled": True,
    "extra": None,
}

# 序列化：Python 对象 → 字符串
text = json.dumps(data, ensure_ascii=False, indent=2)
print(text)

# 反序列化：字符串 → Python 对象
parsed = json.loads(text)
print(parsed["config"]["timeout"])      # 30

# 读写文件
from pathlib import Path

Path("data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
loaded = json.loads(Path("data.json").read_text(encoding="utf-8"))

# 更方便的 dump / load（直接操作文件对象）
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

with open("data.json", encoding="utf-8") as f:
    loaded = json.load(f)
```

**​`ensure_ascii=False`​**​ **一定要加**：

```python
import json

print(json.dumps({"name": "小明"}))                          # {"name": "\u5c0f\u660e"}
print(json.dumps({"name": "小明"}, ensure_ascii=False))      # {"name": "小明"}
```

不加的话中文会变成 ​`\uXXXX` 转义，文件不可读（虽然功能正常）。

**JSON 的类型映射**：

|Python|JSON|注意|
| -------------| --------------| -------------------|
|`dict`|object|key 必须是 str|
|`list`​ / ​`tuple`|array|tuple 会变成 list|
|`str`|string||
|`int`​ / ​`float`|number||
|`True`​ / ​`False`|true / false||
|`None`|null||
|`datetime`|❌ 不支持|需先 ​`.isoformat()`|

<!-- fixture note: the fence below is hand written on purpose.
     It proves that image syntax inside a code fence is never uploaded (S4 scan rule). -->

```markdown
![example](assets/image-20261124161531-ag7m6zn.png)
```
