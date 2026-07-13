# -*- coding: utf-8 -*-
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1080, 864
OUT = os.path.dirname(os.path.abspath(__file__)) + "/assets"

def font(size, bold=True):
    # 尝试系统中文字体
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc",  # 微软雅黑粗体
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/simsum.ttc",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

def wrap(text, draw, fnt, max_w):
    lines = []
    for paragraph in text.split("\n"):
        line = ""
        for ch in paragraph:
            test = (line + ch)
            if draw.textlength(test, font=fnt) <= max_w:
                line = test
            else:
                lines.append(line)
                line = ch
        lines.append(line)
    return lines

def make(name, title, subtitle, bg, fg, accent):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    # 顶部装饰条
    d.rectangle([0, 0, W, 16], fill=accent)
    d.rectangle([0, H-16, W, H], fill=accent)
    # 来源标签
    src_f = font(34)
    d.text((80, 110), subtitle, font=src_f, fill=accent)
    # 标题（自动换行）
    tf = font(72)
    lines = wrap(title, d, tf, W - 160)
    y = 230
    for ln in lines:
        d.text((80, y), ln, font=tf, fill=fg)
        y += 96
    # 底部署名
    bf = font(30)
    d.text((80, H-110), "来源：光明网 / 中国教育报", font=bf, fill=(150,150,150))
    p = os.path.join(OUT, name)
    img.save(p, "PNG")
    print("saved", p)

make("cover_xinjiang.png",
     "新疆出台学生体质强健计划实施方案",
     "光明网 · 时政",
     (245, 248, 252), (28, 42, 64), (22, 119, 184))

make("cover_football.png",
     "外国文学中的足球：等待与哲思",
     "光明网 · 文化",
     (250, 246, 240), (40, 30, 24), (180, 90, 40))

make("cover_zhejiang.png",
     "浙江启动大学生体质提升专项行动",
     "中国教育报 · 体育",
     (240, 250, 244), (24, 50, 38), (33, 150, 90))

print("ALL DONE")
