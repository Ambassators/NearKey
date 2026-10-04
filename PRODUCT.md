# Product

## Register

brand

The homepage at `/` is a brand surface for a demo audience. Everything behind `#/login` (sign-in, phone setup, dashboard) is product UI and keeps the existing app conventions.

## Users

Hackathon judges, security-minded developers and curious visitors opening `http://localhost:5173` on a Mac in Chromium, usually with the presenter's Android phone on the table. They have about ten seconds to understand the idea before they click "Try the demo". Afterwards they are inside the sign-in flow and want it to feel like the same product.

## Product Purpose

NearKey is a two-factor authentication provider demo. A password opens a pending login; the enrolled Android phone nearby signs a single-use, 60-second server challenge and the browser relays the proof over Bluetooth LE. The homepage exists to explain that idea truthfully, show the phone→laptop handoff, and route people into the working demo. Success: a visitor can retell "my phone is the key, nothing to type" and knows what the demo does and does not prove.

## Brand Personality

Calm, exact, honest. Three words: nearby, quiet, verifiable. The voice states what happens and what is proven, never oversells (BLE proves key possession, not distance or consent). Warm forest green and mint, soft geometry, one signature motion: the key tossed from the phone into the laptop's lock.

## Anti-references

- Generic SaaS security pages: shield icons in rounded squares above every heading, padlock stock photos, "bank-grade encryption" copy.
- Dark "cyber" aesthetics: neon, grids, glitch, terminal mono costume.
- Hero-metric templates, gradient text, glass cards, eyebrow labels on every section.

## Design Principles

- Show the handoff: the phone→laptop key toss is the one idea; every section supports it.
- Say what it proves: security claims are concrete and scoped to the demo.
- One product: the homepage uses the app's own palette, type and button shapes so entering sign-in feels continuous.
- Motion with intent: one choreographed load, one scroll-driven sequence, loops only where they explain something.
- Honest edges: demo scope and limitations are on the page, not hidden in a README.

## Accessibility & Inclusion

WCAG 2.2 AA. Body text ≥ 4.5:1 on paper and on green. Every animation has a `prefers-reduced-motion` alternative (static end state). Keyboard-reachable nav and CTAs with visible focus. Decorative SVG scenes are `aria-hidden`; a live status line is `aria-live="off"` to avoid chatter.
