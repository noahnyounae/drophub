#!/usr/bin/env python3
"""Generates the DropHub logo (a mailbox with a downward arrow above it) as an SVG.

Pure standard library, no dependencies:  python3 tools/make_logo.py
"""
from pathlib import Path

BLUE, DARK, WHITE, AMBER, RED = "#2563eb", "#1e40af", "#ffffff", "#fbbf24", "#ef4444"

SHAPES = [
    # background tile
    f'<rect width="256" height="256" rx="56" fill="{BLUE}"/>',
    # post
    f'<rect x="118" y="200" width="20" height="38" rx="3" fill="#dbe4ff"/>',
    # flag: pole + banner, on the right side of the box
    f'<rect x="190" y="124" width="6" height="54" rx="3" fill="{RED}"/>',
    f'<rect x="196" y="124" width="28" height="18" rx="3" fill="{RED}"/>',
    # mailbox body (arched top)
    f'<path d="M72 206 V168 A56 56 0 0 1 184 168 V206 Z" fill="{WHITE}"/>',
    # mail slot and door handle
    f'<rect x="98" y="148" width="60" height="9" rx="4.5" fill="{DARK}"/>',
    f'<circle cx="128" cy="184" r="6" fill="{DARK}"/>',
    # downward arrow above the box
    f'<path d="M116 20 H140 V58 H164 L128 100 L92 58 H116 Z" fill="{AMBER}"/>',
]


def build() -> str:
    body = "\n  ".join(SHAPES)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" '
        'role="img" aria-label="DropHub">\n'
        f"  {body}\n</svg>\n"
    )


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "public" / "static" / "logo.svg"
    out.write_text(build(), encoding="utf-8")
    print(f"wrote {out}")
