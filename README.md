# AImposter

A free, endless spot-the-AI game: every round shows one image, real photo or AI-generated, and you guess. Built around the Akinator money mechanic, where a single play creates ~16 ad page-states instead of one.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Stars](https://img.shields.io/github/stars/suncal/aimposter?style=social)](https://github.com/suncal/aimposter/stargazers)

## What it does

- Daily (shareable Wordle-style), Endless (lives and rewarded revive) and Blitz (60 seconds) modes
- Combo multiplier, XP and ranks, 10 achievements, daily streak, power-ups
- Every ad refresh is tied to a user click, which is what AdSense policy requires
- Content pipeline in Python generates rounds; a small Cloudflare Worker serves the daily set

## Run it

Open `index.html` through a static server. Regenerate rounds with `build_content.py`. Verify or replace the image pool with your own licensed photos before monetising.

---

**If this is useful to you, a ⭐ on the repo helps other people find it.** Issues and pull requests are welcome.

Built by [Priyankar "Sunny" Chakraborty](https://github.com/suncal) · [everbuiltstudio.com](https://everbuiltstudio.com)
