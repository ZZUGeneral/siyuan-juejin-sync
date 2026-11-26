<!--
  fixture: sample-3.md

  This one is SYNTHETIC on purpose. Real 3.8.12 exports already flatten block refs into
  plain text and omit IAL, but the cleaner must stay defensive for older exports and for
  custom-attribute blocks (see docs/ARCHITECTURE.md §5.1). Every rule of the S0-S5 pipeline
  has a counterpart here.
-->

# 兼容性样本

普通段落带有零宽字符 `inline`​ ​`code`​，后面紧跟块属性。
这一行结尾有行内 IAL{: id="20240101120000-abcdefg" updated="20240101120100"}
{: custom-juejin-demo="1" style="color: red"}

块引用写法：((20240101120000-abcdefg "被引用的段落")) 以及无文字形态 ((20240101120000-hijklmn))。

文档引用：[另一篇笔记](siyuan://blocks/20240101120000-opqrstu) 与裸引用 [[20240101120000-vwxyz12]]。

超级块：

{{{row
第一列内容

第二列内容
}}}

挂件块：

<div data-type="NodeWidget" data-node-id="20240101120000-widget1">
  <span>挂件里的假图片 ![inside](assets/fake-widget.png)</span>
</div>

数据库块：

<div data-type="NodeAttributeView" data-av-id="20240101120000-av00001">
  <div class="av__row">行一</div>
</div>

内嵌网页：

<iframe src="https://example.com/embed" width="100%" height="320"></iframe>

视频块：

<video src="assets/video-20240101120000-demo.mp4" controls></video>

音频块：

<audio src="assets/audio-20240101120000-demo.mp3" controls></audio>

真实图片（应被识别为本地图片）：

![真实图片](assets/image-20240101120000-real01.png)

外链图片（P0 保留原样并告警）：

![远程图片](https://example.com/remote.png)

代码围栏里的假图片（**不得**被识别）：

```markdown
![fenced](assets/image-20240101120000-fenced.png)
```

行内代码里的假图片：`![inline](assets/image-20240101120000-inline.png)`

高亮 ==需要保留== 与行内公式 $a^2+b^2=c^2$。

脚注引用[^1]。

[^1]: 这是一条脚注说明。

| 列一 | 列二 |
| --- | --- |
| 甲 | 乙 |
