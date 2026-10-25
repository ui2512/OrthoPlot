# -*- coding: utf-8 -*-
"""
presets_data.py —— 预设函数库（纯数据模块，不依赖 sympy）
============================================================

独立成模块的原因：/api/presets 只需要这份静态数据，若经由 function_engine
取用会连带触发 sympy 导入（手机上数秒）。app.py 直接导入本模块，
页面打开时预设库立即可用。
"""

from __future__ import annotations

from typing import Any

PRESETS: list[dict[str, Any]] = [
    {
        "group": "一次函数（正比例函数）",
        "items": [
            {"name": "y = 2x + 1", "expr": "2x+1", "note": "k>0，直线上升"},
            {"name": "y = -3x + 2", "expr": "-3x+2", "note": "k<0，直线下降"},
            {"name": "y = 3x", "expr": "3x", "note": "正比例函数，过原点"},
            {"name": "y = kx + b", "expr": "kx+b", "params": {"k": 1, "b": 0}, "note": "参数可拖动"},
        ],
    },
    {
        "group": "二次函数",
        "items": [
            {"name": "y = x²", "expr": "x^2", "note": "最基本的抛物线"},
            {"name": "y = 2x² - 3x + 1", "expr": "2x^2-3x+1", "note": "a>0，开口向上"},
            {"name": "y = -x² + 4x - 1", "expr": "-x^2+4x-1", "note": "a<0，开口向下"},
            {"name": "y = ax² + bx + c", "expr": "a*x^2+b*x+c", "params": {"a": 1, "b": 0, "c": 0}, "note": "参数可拖动"},
        ],
    },
    {
        "group": "反比例函数",
        "items": [
            {"name": "y = 1/x", "expr": "1/x", "note": "k>0，一、三象限"},
            {"name": "y = -2/x", "expr": "-2/x", "note": "k<0，二、四象限"},
            {"name": "y = 6/(x-1)", "expr": "6/(x-1)", "note": "中心右移的双曲线"},
            {"name": "y = k/x", "expr": "k/x", "params": {"k": 1}, "note": "参数可拖动"},
        ],
    },
    {
        "group": "指数函数",
        "items": [
            {"name": "y = 2^x", "expr": "2^x", "note": "a>1，单调递增"},
            {"name": "y = (1/2)^x", "expr": "(1/2)^x", "note": "0<a<1，单调递减"},
            {"name": "y = e^x", "expr": "e^x", "note": "自然指数"},
            {"name": "y = e^(-x²)", "expr": "e^(-x^2)", "note": "钟形曲线"},
        ],
    },
    {
        "group": "对数函数",
        "items": [
            {"name": "y = ln(x)", "expr": "ln(x)", "note": "自然对数"},
            {"name": "y = lg(x)", "expr": "lg(x)", "note": "常用对数"},
            {"name": "y = log2(x)", "expr": "log2(x)", "note": "以 2 为底"},
            {"name": "y = ln(x²)", "expr": "ln(x^2)", "note": "定义域 x≠0"},
        ],
    },
    {
        "group": "幂函数与根式",
        "items": [
            {"name": "y = x³", "expr": "x^3", "note": "三次函数"},
            {"name": "y = x^(-2)", "expr": "x^(-2)", "note": "偶次负幂"},
            {"name": "y = √x", "expr": "sqrt(x)", "note": "定义域 x≥0"},
            {"name": "y = x^(1/3)", "expr": "x^(1/3)", "note": "立方根"},
        ],
    },
    {
        "group": "三角函数",
        "items": [
            {"name": "y = sin(x)", "expr": "sin(x)", "note": "正弦曲线"},
            {"name": "y = 2sin(2x + π/3)", "expr": "2sin(2x+pi/3)", "note": "振幅与相位"},
            {"name": "y = cos(x)", "expr": "cos(x)", "note": "余弦曲线"},
            {"name": "y = tan(x)", "expr": "tan(x)", "note": "含垂直渐近线"},
        ],
    },
    {
        "group": "绝对值与分段",
        "items": [
            {"name": "y = |x|", "expr": "|x|", "note": "绝对值函数"},
            {"name": "y = |x - 1| + 2", "expr": "|x-1|+2", "note": "平移后的 V 形"},
            {"name": "y = floor(x)", "expr": "floor(x)", "note": "取整阶梯函数"},
            {"name": "y = sign(x)", "expr": "sign(x)", "note": "符号函数"},
        ],
    },
    {
        "group": "综合与复合",
        "items": [
            {"name": "y = x·sin(1/x)", "expr": "x*sin(1/x)", "note": "原点附近振荡"},
            {"name": "y = 1/(1 + x²)", "expr": "1/(1+x^2)", "note": "钟形有理函数"},
            {"name": "y = x³ - 3x", "expr": "x^3-3x", "note": "两个极值点"},
            {"name": "y = sin(x)/x", "expr": "sin(x)/x", "note": "重要极限函数"},
        ],
    },
]
