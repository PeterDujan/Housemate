import { exampleHouseholdName, householdOwner, householdOwnerId } from "./household.js";
import { assistantName, assistantPronounPossessive } from "./persona.js";
/**
 * The assistant's page (the ingress root and `/dashboard-ui`), in the Luxe look: obsidian glass,
 * champagne accent, Inter, no radius above 6px. An admin shell: a sidebar of eight sections. Everything
 * it needs ships with the app (Inter is served at `assets/inter.woff2`); it never loads a house's
 * own files, so every house sees the same page. Narrow screens reflow the same design to one column.
 *
 * The client script avoids template literals so this file needs no escaping.
 */
export function dashboardPageHtml(): string {
  const name = assistantName().replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const their = assistantPronounPossessive();
  const Their = their.charAt(0).toUpperCase() + their.slice(1);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#08080a">
  <title>${name}</title>
  <style>
    @font-face {
      font-family: 'Inter';
      src: url('assets/inter.woff2') format('woff2');
      font-weight: 100 900;
      font-display: swap;
    }
    :root {
      color-scheme: dark;
      --lx-font: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --lx-ink: #f4f1ea;
      --lx-ink-2: rgba(236,232,224,0.80);
      --lx-ink-3: rgba(236,232,224,0.58);
      --lx-ink-4: rgba(236,232,224,0.40);
      --lx-gold: #d9c296;
      --lx-gold-hi: #f3e6c8;
      --lx-gold-rgb: 217,194,150;
      --lx-ok: #6fe0b6; --lx-ok-rgb: 111,224,182;
      --lx-cool: #7cc8ff; --lx-cool-rgb: 124,200,255;
      --lx-warn: #f0c674; --lx-warn-rgb: 240,198,116;
      --lx-bad: #ff7a8a; --lx-bad-rgb: 255,122,138;
      --lx-line: rgba(255,255,255,0.075);
      --lx-line-2: rgba(255,255,255,0.13);
      --lx-fill: rgba(255,255,255,0.035);
      --lx-fill-2: rgba(255,255,255,0.06);
      --lx-fill-3: rgba(255,255,255,0.095);
      --lx-r: 6px;
      --lx-glass-tint: rgba(15,15,18,0.30);
      --lx-glass-sheen: linear-gradient(180deg,rgba(255,255,255,0.075) 0%,rgba(255,255,255,0.028) 34%,rgba(255,255,255,0.012) 100%);
      --lx-glass-filter: blur(26px) saturate(1.25) brightness(0.94);
      --lx-shadow: 0 36px 72px -30px rgba(0,0,0,0.72), 0 14px 28px -14px rgba(0,0,0,0.45);
      --lx-ease: cubic-bezier(0.22,1,0.36,1);
      --lx-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.07 0 0 0 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") 0 0/180px 180px repeat;
    }
    * { box-sizing: border-box; }
    html { background: #08080a; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      color: rgba(236,232,224,0.86);
      font-family: var(--lx-font);
      font-feature-settings: 'cv11' 1, 'tnum' 1;
      -webkit-font-smoothing: antialiased;
      letter-spacing: 0.01em;
      background: #08080a;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      z-index: -2;
      background:
        radial-gradient(60% 45% at 18% 8%, rgba(var(--lx-gold-rgb),0.13), transparent 70%),
        radial-gradient(55% 50% at 88% 30%, rgba(var(--lx-cool-rgb),0.09), transparent 72%),
        radial-gradient(70% 55% at 40% 100%, rgba(120,90,160,0.10), transparent 75%),
        linear-gradient(160deg, #121216 0%, #0a0a0d 45%, #08080a 100%);
    }
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background:
        radial-gradient(125% 95% at 50% 38%, rgba(0,0,0,0.18) 40%, rgba(0,0,0,0.62) 100%),
        linear-gradient(180deg, rgba(0,0,0,0.42), rgba(0,0,0,0.20) 24%, rgba(0,0,0,0.30) 76%, rgba(0,0,0,0.55));
    }
    ::selection { background: rgba(var(--lx-gold-rgb),0.32); color: #fff; }
    /* Admin shell: a sidebar of sections, one section on show */
    .app { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; min-height: 100dvh; }
    .side { position: sticky; top: 0; height: 100vh; height: 100dvh; overflow-y: auto; display: flex; flex-direction: column; gap: 24px; padding: 26px 14px max(20px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); border-right: 1px solid var(--lx-line); background: rgba(8,8,10,0.55); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px); }
    .brand { display: grid; gap: 12px; padding: 0 10px; }
    .nav { display: grid; gap: 2px; }
    .nav-item { appearance: none; border: 0; background: transparent; color: var(--lx-ink-3); font: inherit; font-size: 0.88rem; font-weight: 500; text-align: left; padding: 10px 12px; border-radius: var(--lx-r); cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 8px; transition: color 0.2s, background 0.2s; }
    .nav-item:hover { color: var(--lx-ink); background: var(--lx-fill); }
    .nav-item[aria-current="page"] { color: var(--lx-gold-hi); background: rgba(var(--lx-gold-rgb),0.12); box-shadow: inset 2px 0 0 var(--lx-gold); }
    .nav-item:focus-visible { outline: 1px solid var(--lx-gold); outline-offset: 2px; }
    .main { min-width: 0; width: 100%; max-width: 1240px; padding: 30px max(32px, env(safe-area-inset-right)) 64px 32px; }
    .view-head { margin-bottom: 18px; }
    .view-head h2 { margin: 0; color: var(--lx-ink); font-size: 1.55rem; font-weight: 300; letter-spacing: -0.01em; }
    .view-head p { margin: 6px 0 0; color: var(--lx-ink-3); font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
    .chat-panel { max-width: 780px; }
    .view .grid + .panel, .view .panel + .grid, .view .panel + .restart-bar, .view .restart-bar + .grid { margin-top: 14px; }

    /* Forms (the personality editor) */
    .form { display: grid; gap: 16px; }
    .field { display: grid; gap: 6px; min-width: 0; }
    .field > span { color: var(--lx-ink-2); font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; }
    .field small, .form .hint { color: var(--lx-ink-4); font-size: 0.74rem; line-height: 1.4; }
    .field textarea { min-height: 0; font-size: 0.9rem; line-height: 1.5; }
    .field-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .form-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .form-note { color: var(--lx-ink-3); font-size: 0.78rem; }
    .form-note.ok { color: var(--lx-gold); }
    .form-note.bad { color: var(--lx-bad); }
    .form.dirty .form-note:empty::before { content: "Unsaved changes"; color: var(--lx-warn); }
    .more summary { cursor: pointer; color: var(--lx-ink-3); font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; }
    .more[open] summary { margin-bottom: 12px; }
    .people { display: grid; gap: 10px; }
    .person { border: 1px solid var(--lx-line); border-radius: var(--lx-r); background: var(--lx-fill); }
    .person-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; }
    .person-name { color: var(--lx-ink); font-size: 0.95rem; font-weight: 500; }
    .person-meta { color: var(--lx-ink-3); font-size: 0.78rem; margin-top: 2px; }
    .person-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .person-actions .btn { min-height: 32px; padding: 0 12px; font-size: 0.74rem; }
    .person-body { display: grid; gap: 14px; padding: 4px 14px 14px; border-top: 1px solid var(--lx-line); padding-top: 14px; }
    .person.editing { border-color: rgba(var(--lx-gold-rgb),0.35); }
    .people-add { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .field select { width: 100%; min-height: 36px; font: inherit; font-size: 0.9rem; color: var(--lx-ink); background: rgba(0,0,0,0.28); border: 1px solid var(--lx-line-2); border-radius: var(--lx-r); padding: 0 10px; color-scheme: dark; }
    .people-foot { margin-top: 14px; }
    .people.dirty ~ .people-foot .form-note:empty::before { content: "Unsaved changes"; color: var(--lx-warn); }
    .progress { height: 8px; border-radius: var(--lx-r); background: var(--lx-fill-2); overflow: hidden; margin: 6px 0 12px; }
    .progress-bar { height: 100%; width: 0; background: linear-gradient(90deg, rgba(var(--lx-gold-rgb),0.55), var(--lx-gold)); transition: width 0.5s var(--lx-ease); }
    .training-text { color: var(--lx-ink); font-size: 0.92rem; margin-bottom: 12px; }
    #training-panel .hint { display: block; margin-top: 14px; }
    .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
    .step { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--lx-line); }
    .step:first-child { border-top: 0; padding-top: 2px; }
    .step .tick { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--lx-line-2); display: grid; place-items: center; color: var(--lx-ok); font-size: 0.8rem; }
    .step.done .tick { border-color: rgba(var(--lx-ok-rgb),0.5); background: rgba(var(--lx-ok-rgb),0.12); }
    .step.done .row-help { display: none; }
    .view .panel.setup + .metrics { margin-top: 14px; }
    .restart-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-radius: var(--lx-r); border: 1px solid rgba(var(--lx-warn-rgb),0.45); background: rgba(var(--lx-warn-rgb),0.10); color: var(--lx-ink); font-size: 0.86rem; }

    .eyebrow { color: var(--lx-gold); font-size: 0.64rem; font-weight: 600; letter-spacing: 0.24em; text-transform: uppercase; margin-bottom: 6px; }
    h1 { margin: 0; color: var(--lx-ink); font-size: 1.6rem; font-weight: 250; letter-spacing: -0.01em; line-height: 1.1; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; gap: 8px; color: var(--lx-ink-3); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lx-ink-4); }
    .dot.ok { background: var(--lx-ok); box-shadow: 0 0 0 3px rgba(var(--lx-ok-rgb),0.14); }
    .dot.bad { background: var(--lx-bad); box-shadow: 0 0 0 3px rgba(var(--lx-bad-rgb),0.14); }

    .card:focus-visible, .btn:focus-visible, .switch:focus-visible, .seg button:focus-visible, .link:focus-visible { outline: 1px solid var(--lx-gold); outline-offset: 2px; }
    .count { min-width: 18px; padding: 1px 5px; border-radius: 4px; background: rgba(var(--lx-gold-rgb),0.22); color: var(--lx-gold-hi); font-size: 0.66rem; letter-spacing: 0; }
    .count:empty { display: none; }
    [hidden] { display: none !important; }

    /* Glass panels: one blur layer, gradient rim, specular top edge */
    .panel {
      position: relative;
      padding: 18px 20px 20px;
      border-radius: var(--lx-r);
      background: var(--lx-grain), var(--lx-glass-sheen), var(--lx-glass-tint);
      box-shadow: var(--lx-shadow);
      backdrop-filter: var(--lx-glass-filter);
      -webkit-backdrop-filter: var(--lx-glass-filter);
      scroll-margin-top: 20px;
      transition: box-shadow 0.4s var(--lx-ease);
    }
    .panel::before {
      content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: inherit; padding: 1px;
      background: linear-gradient(150deg, rgba(255,255,255,0.30), rgba(255,255,255,0.07) 22%, rgba(255,255,255,0.015) 55%, rgba(var(--lx-gold-rgb),0.16) 100%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
    }
    .panel::after { content: ''; position: absolute; top: 0; left: 12%; right: 12%; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.60), transparent); opacity: 0.5; pointer-events: none; }
    .panel.flash { box-shadow: 0 0 0 1px rgba(var(--lx-gold-rgb),0.55), var(--lx-shadow); }
    .plabel { color: var(--lx-ink); font-size: 0.72rem; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; }
    .ptitle { color: var(--lx-ink-3); font-size: 0.86rem; margin: 4px 0 14px; }

    /* Metric cards: nested, so a faint lift and no second blur */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .card { appearance: none; text-align: left; font: inherit; color: inherit; cursor: pointer; min-width: 0; padding: 14px 16px; border-radius: var(--lx-r); border: 1px solid var(--lx-line); background: var(--lx-glass-sheen), rgba(15,15,18,0.42); backdrop-filter: var(--lx-glass-filter); -webkit-backdrop-filter: var(--lx-glass-filter); transition: border-color 0.25s, background 0.25s; }
    .card:hover { border-color: rgba(var(--lx-gold-rgb),0.45); }
    .label { color: var(--lx-ink-3); font-size: 0.6rem; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; }
    .value { color: var(--lx-ink); font-size: 1.7rem; font-weight: 250; letter-spacing: -0.01em; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .note { color: var(--lx-ink-4); font-size: 0.74rem; margin-top: 2px; }

    .stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
    .grid > *, .panel { min-width: 0; }

    /* Lists */
    .item { padding: 12px 0; border-top: 1px solid var(--lx-line); }
    .item:first-child { border-top: 0; padding-top: 0; }
    .head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .route { color: var(--lx-ink); font-weight: 600; font-size: 0.86rem; }
    .meta { color: var(--lx-ink-4); font-size: 0.74rem; }
    .line { margin-top: 6px; line-height: 1.45; white-space: pre-wrap; font-size: 0.9rem; overflow-wrap: anywhere; }
    .route, .row-name, .bubble { overflow-wrap: anywhere; }
    .answer { color: var(--lx-ink-2); }
    .empty { color: var(--lx-ink-4); font-size: 0.88rem; }
    .error { color: var(--lx-bad); margin-top: 14px; font-size: 0.86rem; }

    /* Chat */
    .bubble { padding: 10px 12px; border-radius: var(--lx-r); margin-top: 8px; background: var(--lx-fill); border: 1px solid var(--lx-line); }
    .bubble:first-child { margin-top: 0; }
    .bubble.me { background: rgba(var(--lx-cool-rgb),0.08); border-color: rgba(var(--lx-cool-rgb),0.18); }
    .composer { margin-top: 14px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
    textarea, input[type="time"], input[type="text"] {
      font: inherit; color: var(--lx-ink); background: rgba(0,0,0,0.28); border: 1px solid var(--lx-line-2); border-radius: var(--lx-r);
      box-shadow: inset 0 1px 2px rgba(0,0,0,0.4);
    }
    textarea { width: 100%; min-height: 72px; resize: vertical; padding: 10px 12px; }
    input[type="text"] { width: 100%; min-height: 36px; padding: 6px 10px; text-transform: none; letter-spacing: 0; font-size: 0.9rem; }
    textarea:focus, input[type="time"]:focus, input[type="text"]:focus { outline: none; border-color: rgba(var(--lx-gold-rgb),0.55); }

    /* Buttons: tinted champagne primary, quiet fill secondary */
    .btn { appearance: none; font: inherit; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.08em; cursor: pointer; min-height: 36px; padding: 0 16px; border-radius: var(--lx-r); color: var(--lx-gold-hi); background: rgba(var(--lx-gold-rgb),0.16); border: 1px solid rgba(var(--lx-gold-rgb),0.42); transition: background 0.2s, border-color 0.2s; }
    .btn:hover { background: rgba(var(--lx-gold-rgb),0.24); }
    .btn.quiet { color: var(--lx-ink-2); background: var(--lx-fill-2); border-color: var(--lx-line-2); }
    .btn.quiet:hover { background: var(--lx-fill-3); }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .composer .btn { min-width: 96px; }
    .actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
    .scroll { max-height: 28rem; overflow-y: auto; padding-right: 6px; }
    .actions.small .btn { min-height: 30px; padding: 0 12px; font-size: 0.72rem; }
    .item.held { opacity: 0.6; }
    .sub { color: var(--lx-ink-3); font-size: 0.66rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; margin: 16px 0 8px; }

    /* Settings */
    .live-note { color: var(--lx-ink-4); font-size: 0.74rem; margin: -6px 0 14px; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; align-items: center; padding: 13px 0; border-top: 1px solid var(--lx-line); }
    .row:first-of-type { border-top: 0; padding-top: 2px; }
    .row-name { color: var(--lx-ink); font-size: 0.92rem; font-weight: 500; }
    .row-help { color: var(--lx-ink-3); font-size: 0.78rem; margin-top: 3px; line-height: 1.4; }
    .row-foot { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 0.72rem; color: var(--lx-ink-4); min-height: 0; }
    .row-foot:empty { display: none; }
    .row.waiting .row-name, .row.waiting .row-help { opacity: 0.55; }
    .waiting-note { color: var(--lx-warn); }
    .saved { color: var(--lx-gold); font-weight: 600; letter-spacing: 0.06em; }
    .failed { color: var(--lx-bad); }
    #house-found-rows, .house-block, .house-head, .device-row > * { min-width: 0; }
    .house-block { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 14px 0; border-top: 1px solid var(--lx-line); overflow-wrap: anywhere; }
    .house-block:first-of-type { border-top: 0; padding-top: 2px; }
    select.pick { width: 100%; min-width: 0; text-overflow: ellipsis; }
    .house-block > select.pick { max-width: 420px; }
    .house-block .hand { color: var(--lx-ink-4); }
    .device-row { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) minmax(0, 1fr); gap: 10px; align-items: center; }
    .device-row select.pick { max-width: none; }
    .speaker-row { grid-template-columns: minmax(0, 0.8fr) minmax(0, 2.2fr); }
    .weather-picks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .option-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
    .option-grid input[type="password"], .option-grid input[type="number"] { width: 100%; min-height: 36px; padding: 6px 10px; font: inherit; font-size: 0.9rem; color: var(--lx-ink); background: rgba(0,0,0,0.28); border: 1px solid var(--lx-line-2); border-radius: var(--lx-r); }
    .check-line { display: flex; gap: 8px; align-items: center; min-height: 36px; color: var(--lx-ink-2); }
    .check-line input { width: 18px; height: 18px; accent-color: var(--lx-gold); }
    input.budget { max-width: 200px; width: 100%; min-height: 36px; padding: 6px 10px; font: inherit; font-size: 0.9rem; color: var(--lx-ink); background: rgba(0,0,0,0.28); border: 1px solid var(--lx-line-2); border-radius: var(--lx-r); }
    .house-when { margin-top: 10px; }
    .block-save[hidden] { display: none; }
    select.pick { min-height: 36px; font: inherit; font-size: 0.86rem; color: var(--lx-ink); background: rgba(0,0,0,0.28); border: 1px solid var(--lx-line-2); border-radius: var(--lx-r); padding: 0 10px; color-scheme: dark; }
    .checklist { grid-column: 1 / -1; display: grid; gap: 2px; padding: 6px 0 2px; }
    .checklist label { display: flex; gap: 10px; align-items: center; min-height: 36px; font-size: 0.88rem; color: var(--lx-ink-2); cursor: pointer; }
    .checklist input { width: 18px; height: 18px; accent-color: var(--lx-gold); }
    .checklist .actions { margin-top: 8px; }
    .link { appearance: none; border: 0; background: none; padding: 0; font: inherit; color: var(--lx-gold); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .lock { color: var(--lx-ink-3); font-size: 0.82rem; }

    .switch { appearance: none; position: relative; width: 44px; height: 24px; flex: none; cursor: pointer; border-radius: var(--lx-r); border: 1px solid var(--lx-line-2); background: rgba(0,0,0,0.34); box-shadow: inset 0 1px 2px rgba(0,0,0,0.5); transition: background 0.25s var(--lx-ease), border-color 0.25s; }
    .switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 4px; background: var(--lx-ink-3); transition: transform 0.25s var(--lx-ease), background 0.25s; }
    .switch[aria-checked="true"] { background: rgba(var(--lx-gold-rgb),0.24); border-color: rgba(var(--lx-gold-rgb),0.55); }
    .switch[aria-checked="true"]::after { transform: translateX(20px); background: var(--lx-gold-hi); }
    .switch:disabled { opacity: 0.45; cursor: default; }

    .seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--lx-r); background: rgba(0,0,0,0.34); box-shadow: inset 0 1px 2px rgba(0,0,0,0.5), 0 0 0 1px var(--lx-line); }
    .seg button { appearance: none; border: 0; background: transparent; color: var(--lx-ink-3); font: inherit; font-size: 0.74rem; font-weight: 600; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    .seg button[aria-checked="true"] { color: var(--lx-gold-hi); background: rgba(var(--lx-gold-rgb),0.16); box-shadow: inset 0 0 0 1px rgba(var(--lx-gold-rgb),0.38); }
    .seg button:disabled { cursor: default; opacity: 0.5; }

    .times { display: flex; align-items: center; gap: 8px; color: var(--lx-ink-4); }

    /* Names */
    .name-row .row-help .missing { color: var(--lx-warn); }
    .name-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .name-actions .btn { min-height: 32px; padding: 0 12px; }
    .name-form { display: grid; gap: 10px; padding: 14px; margin-bottom: 12px; border-radius: var(--lx-r); background: var(--lx-fill); border: 1px solid var(--lx-line-2); }
    .name-form label { display: grid; gap: 5px; color: var(--lx-ink-3); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
    .name-form .devices { display: grid; gap: 6px; }
    .name-form .device { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
    .name-form .device .btn { min-height: 34px; padding: 0 10px; }
    .roster { color: var(--lx-ink-2); font-size: 0.9rem; line-height: 1.5; }
    input[type="time"] { padding: 6px 8px; min-height: 34px; color-scheme: dark; }

    @media (max-width: 1100px) {
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 860px) {
      /* The sidebar becomes a bar on top: the name, then the sections in one scrolling row. */
      .app { grid-template-columns: 1fr; }
      .side { position: static; height: auto; gap: 12px; padding: 14px max(14px, env(safe-area-inset-right)) 10px max(14px, env(safe-area-inset-left)); border-right: 0; border-bottom: 1px solid var(--lx-line); }
      .brand { grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: 0 2px; }
      .nav { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; margin: 0 -14px; padding: 0 14px 2px; }
      .nav::-webkit-scrollbar { display: none; }
      .nav-item { flex: none; white-space: nowrap; padding: 9px 12px; }
      .nav-item[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--lx-gold); }
      .main { padding: 18px max(14px, env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
      .view-head h2 { font-size: 1.3rem; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
      .card { padding: 12px; }
      .value { font-size: 1.35rem; }
      .grid, .stack { gap: 10px; }
      .panel { padding: 16px 14px; }
      .composer { grid-template-columns: 1fr; }
      .field-pair { grid-template-columns: 1fr; }
      .field select { font-size: 16px; min-height: 44px; }
      .step { grid-template-columns: 24px minmax(0, 1fr); }
      .step .btn { grid-column: 2; justify-self: start; }
      .composer .btn { width: 100%; }
      .btn { min-height: 44px; }
      .actions.small .btn { min-height: 38px; }
      /* 16px stops iPhones zooming into a field on focus. */
      textarea, input[type="text"], input[type="time"] { font-size: 16px; }
      .scroll { max-height: 60vh; }
      .row { gap: 8px 12px; }
      .row:has(.seg), .row:has(.times), .row:has(.name-actions) { grid-template-columns: 1fr; }
      .device-row { grid-template-columns: 1fr; gap: 6px; padding-bottom: 6px; }
      .house-block > select.pick { max-width: none; }
      .weather-picks, .option-grid { grid-template-columns: 1fr; }
      .option-grid input[type="password"], .option-grid input[type="number"] { font-size: 16px; min-height: 44px; }
      input.budget { max-width: none; font-size: 16px; min-height: 44px; }
      select.pick { width: 100%; font-size: 16px; min-height: 44px; }

      .checklist label { min-height: 44px; }
      .seg { display: flex; flex-wrap: wrap; }
      .seg button { flex: 1; min-height: 36px; }
      .times { flex-wrap: wrap; }
      .name-actions { justify-content: flex-start; }
      .name-form .device { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <div>
          <div class="eyebrow">Housemate</div>
          <h1>${name}</h1>
        </div>
        <div class="status"><span class="dot" id="status-dot"></span><span id="status">loading</span></div>
      </div>
      <nav class="nav" aria-label="Sections">
        <button type="button" class="nav-item" id="nav-overview" data-view="overview" aria-current="false">Overview<span class="count" id="count-overview"></span></button>
        <button type="button" class="nav-item" id="nav-chat" data-view="chat" aria-current="false">Chat<span class="count" id="count-chat"></span></button>
        <button type="button" class="nav-item" id="nav-assistant" data-view="assistant" aria-current="false">Assistant<span class="count" id="count-assistant"></span></button>
        <button type="button" class="nav-item" id="nav-people" data-view="people" aria-current="false">People<span class="count" id="count-people"></span></button>
        <button type="button" class="nav-item" id="nav-memory" data-view="memory" aria-current="false">Memory<span class="count" id="count-memory"></span></button>
        <button type="button" class="nav-item" id="nav-speaking" data-view="speaking" aria-current="false">Speaking up<span class="count" id="count-speaking"></span></button>
        <button type="button" class="nav-item" id="nav-house" data-view="house" aria-current="false">House<span class="count" id="count-house"></span></button>
        <button type="button" class="nav-item" id="nav-system" data-view="system" aria-current="false">System<span class="count" id="count-system"></span></button>
      </nav>
    </aside>

    <main class="main">
      <section class="view" id="view-overview" aria-labelledby="nav-overview">
        <header class="view-head"><h2>Overview</h2><p>How ${name} is doing right now.</p></header>
        <div class="panel wide setup" id="setup-panel" hidden>
          <div class="plabel">Finish Setting Up</div>
          <div class="ptitle">A few things before ${name} can look after the house</div>
          <ol class="steps" id="setup-steps"></ol>
        </div>
        <div class="metrics" id="metrics"></div>
        <div class="panel" id="turns-panel">
          <div class="plabel">Recent Turns</div>
          <div class="ptitle">What ${name} heard</div>
          <div id="turns" class="empty">No turns logged yet.</div>
        </div>
      </section>
      <section class="view" id="view-chat" aria-labelledby="nav-chat" hidden>
        <header class="view-head"><h2>Chat</h2><p>Talk to ${name} from here.</p></header>
        <div class="panel chat-panel" id="chat-panel">
          <div class="plabel">Live Chat</div>
          <div class="ptitle">Talk to ${name}</div>
          <div id="messages"></div>
          <form class="composer" id="chat-form">
            <textarea id="draft" placeholder="Ask ${name} something..."></textarea>
            <button class="btn" id="send" type="submit">Send</button>
          </form>
        </div>
      </section>
      <section class="view" id="view-assistant" aria-labelledby="nav-assistant" hidden>
        <header class="view-head"><h2>Assistant</h2><p>Name, personality, and how ${name} talks and grows.</p></header>
        <div class="grid">
          <div class="panel" id="identity-panel">
            <div class="plabel">Name</div>
            <div class="ptitle">What ${name} is called</div>
            <form id="persona-name" class="form" data-persona-form="name" novalidate>
              <label class="field"><span>Name</span><input type="text" name="name" maxlength="40" autocomplete="off" required></label>
              <div class="field"><span>Pronoun</span><div class="seg" role="radiogroup" aria-label="Pronoun" data-pronoun>
                <button type="button" role="radio" data-value="he">He</button><button type="button" role="radio" data-value="she">She</button><button type="button" role="radio" data-value="they">They</button>
              </div></div>
              <label class="field"><span>Nicknames</span><input type="text" name="aliases" autocomplete="off" placeholder="Separate with commas"><small>Other names it answers to when spoken to.</small></label>
              <label class="field"><span>Often misheard as</span><input type="text" name="misheard_as" autocomplete="off" placeholder="Separate with commas"><small>How speech-to-text gets the name wrong, so it still knows it is meant.</small></label>
              <div class="form-foot"><button type="submit" class="btn">Save</button><button type="button" class="btn quiet" data-persona-undo>Undo changes</button><span class="form-note" aria-live="polite"></span></div>
              <small class="hint">A new name or pronoun takes a restart of Housemate. The wake word is set on each speaker, not here.</small>
            </form>
          </div>
          <div class="panel" id="settings-talking">
            <div class="plabel">Talking</div>
            <div class="ptitle">How ${name} chats</div>
            <div class="live-note">Changes are live. No restart.</div>
            <div data-group="talking" class="empty">Loading...</div>
          </div>
        </div>
        <div class="panel wide" id="personality-panel">
          <div class="plabel">Personality</div>
          <div class="ptitle">Who ${name} is, in ${their} own words</div>
          <form id="persona-text" class="form" data-persona-form="text" novalidate>
            <label class="field"><span>Character</span><textarea name="character" rows="10"></textarea><small>One trait per line. Write {name} where the name goes.</small></label>
            <label class="field"><span>Chat style</span><input type="text" name="turn_mode" maxlength="400" autocomplete="off"><small>One line on how to answer in open chat.</small></label>
            <div class="field-pair">
              <label class="field"><span>"Who made you?"</span><input type="text" name="creator" maxlength="400" autocomplete="off"></label>
              <label class="field"><span>"How old are you?"</span><input type="text" name="age_answer" maxlength="400" autocomplete="off"></label>
            </div>
            <label class="field"><span>Introductions</span><textarea name="introductions" rows="3"></textarea><small>Answers to "who are you?", one per line; one is picked each time.</small></label>
            <details class="more"><summary>Identity rules</summary>
              <label class="field"><span>Identity</span><textarea name="identity" rows="10"></textarea><small>The ground rules the model always gets. Change with care.</small></label>
            </details>
            <div class="form-foot"><button type="submit" class="btn">Save</button><button type="button" class="btn quiet" data-persona-undo>Undo changes</button><button type="button" class="link" data-persona-defaults>Use the defaults</button><span class="form-note" aria-live="polite"></span></div>
          </form>
        </div>
        <div class="panel wide" id="voice-words-panel">
          <div class="plabel">Spoken words</div>
          <div class="ptitle">What ${name} says when a speaker wakes and when it's done</div>
          <form id="voice-words" class="form" novalidate>
            <div class="field-pair">
              <label class="field"><span>Greeting</span><input type="text" name="greeting" maxlength="60" autocomplete="off"><small>Said when you wake a speaker.</small></label>
              <label class="field"><span>Goodbye</span><input type="text" name="goodbye" maxlength="60" autocomplete="off"><small>Said when a conversation ends.</small></label>
            </div>
            <label class="field"><span>Stop phrase</span><input type="text" name="stop_phrase" maxlength="60" autocomplete="off"><small>Say this to end a conversation straight away.</small></label>
            <div class="form-foot"><button type="submit" class="btn">Save</button><span class="form-note" aria-live="polite"></span></div>
            <small class="hint">These take a restart of Housemate.</small>
          </form>
        </div>
        <div class="restart-bar" id="restart-bar" hidden>
          <span>Saved. Restart Housemate to use the change.</span>
          <button type="button" class="btn" data-restart>Restart Housemate</button>
        </div>
        <div class="grid">
          <div class="panel" id="growth-panel">
            <div class="plabel">Growth</div>
            <div class="ptitle">How ${name} has changed, night by night</div>
            <div id="growth" class="scroll empty">Loading...</div>
          </div>
          <div class="panel" id="tastes-panel">
            <div class="plabel">${Their} Tastes</div>
            <div class="ptitle">What ${name} likes, and has said in chat</div>
            <div id="tastes" class="scroll empty">Loading...</div>
          </div>
        </div>
      </section>
      <section class="view" id="view-people" aria-labelledby="nav-people" hidden>
        <header class="view-head"><h2>People</h2><p>Who lives here, and how ${name} tells them apart.</p></header>
        <div class="panel wide" id="people-panel">
          <div class="plabel">Household</div>
          <div class="ptitle">Who lives here</div>
          <div id="people-list" class="people empty">Loading...</div>
          <div class="people-add"><button type="button" class="btn quiet" data-people-add>Add person</button></div>
          <div class="form-foot people-foot">
            <button type="button" class="btn" data-people-save>Save</button>
            <button type="button" class="btn quiet" data-people-undo>Undo changes</button>
            <span class="form-note" id="people-note" aria-live="polite"></span>
          </div>
          <small class="hint">Link each person to their Home Assistant person (Settings &gt; People) so ${name} knows who is who. Changes take a restart of Housemate.</small>
        </div>
        <div class="panel wide" id="training-panel" hidden>
          <div class="plabel">Voice Training</div>
          <div class="ptitle" id="training-title">Train a voice</div>
          <div id="training-setup">
            <label class="field"><span>Speaker</span><select id="training-satellite"></select>
              <small>The speaker says each sentence and beeps; repeat the sentence after the beep. Its voice assistant must be Housemate.</small></label>
            <div class="form-foot"><button type="button" class="btn" data-training-start>Start</button><button type="button" class="btn quiet" data-training-close>Close</button><span class="form-note" id="training-note" aria-live="polite"></span></div>
          </div>
          <div id="training-run" hidden>
            <div class="progress" role="progressbar" aria-label="Voice training" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" id="training-bar"></div></div>
            <div class="training-text" id="training-text" aria-live="polite"></div>
            <div class="form-foot"><button type="button" class="btn quiet" data-training-cancel>Stop</button><button type="button" class="btn quiet" data-training-close hidden>Close</button></div>
          </div>
          <small class="hint">Recordings are kept only until training finishes, then deleted. Training again replaces the old voice. If a later update changes voice recognition, everyone trains again.</small>
        </div>
        <div class="restart-bar" id="people-restart" hidden>
          <span>Saved. Restart Housemate to use the new household.</span>
          <button type="button" class="btn" data-restart>Restart Housemate</button>
        </div>
      </section>
      <section class="view" id="view-memory" aria-labelledby="nav-memory" hidden>
        <header class="view-head"><h2>Memory</h2><p>What ${name} keeps, and what needs a look.</p></header>
        <div class="grid">
          <div class="stack">
            <div class="panel" id="held-panel">
              <div class="plabel">Memories To Check</div>
              <div class="ptitle">Things ${name} wants to keep</div>
              <div id="held" class="empty">Nothing waiting.</div>
            </div>
            <div class="panel" id="review-panel">
              <div class="plabel">Review Queue</div>
              <div class="ptitle">Memory review</div>
              <div id="review" class="empty">Review queue clear.</div>
            </div>
            <div class="panel" id="corrections-panel">
              <div class="plabel">Corrections</div>
              <div class="ptitle">Answers someone said were wrong</div>
              <div id="corrections" class="empty">No open corrections.</div>
            </div>
          </div>
          <div class="stack">
            <div class="panel" id="stored-panel">
              <div class="plabel">Stored Memories</div>
              <div class="ptitle">What ${name} has kept</div>
              <div id="stored" class="scroll empty">Loading...</div>
            </div>
            <div class="panel" id="settings-memory">
              <div class="plabel">Memory</div>
              <div class="ptitle">What ${name} keeps</div>
              <div data-group="memory" class="empty">Loading...</div>
            </div>
          </div>
        </div>
      </section>
      <section class="view" id="view-speaking" aria-labelledby="nav-speaking" hidden>
        <header class="view-head"><h2>Speaking up</h2><p>When ${name} speaks without being asked.</p></header>
        <div class="grid">
          <div class="panel" id="settings-quiet">
            <div class="plabel">Quiet &amp; Proactive</div>
            <div class="ptitle">When ${name} speaks up</div>
            <div id="helpers"></div>
            <div data-group="quiet" class="empty">Loading...</div>
            <div class="sub">Kinds of idea</div>
            <div id="proactive-types" class="empty">Loading...</div>
          </div>
          <div class="panel" id="proactive-panel">
            <div class="plabel">Proactive Shadows</div>
            <div class="ptitle">What ${name} would have said unprompted</div>
            <div id="proactive" class="scroll empty">Loading...</div>
          </div>
        </div>
      </section>
      <section class="view" id="view-house" aria-labelledby="nav-house" hidden>
        <header class="view-head"><h2>House</h2><p>What ${name} may control, and what things are called.</p></header>
        <div class="grid">
          <div class="stack">
            <div class="panel" id="house-found">
              <div class="plabel">From Home Assistant</div>
              <div class="ptitle">Set up from your Home Assistant</div>
              <div class="live-note">${name} fills these in from your Home Assistant, and adds anything new by itself. Change anything here and a Save button appears under it.</div>
              <div class="actions" style="margin: -4px 0 12px"><button type="button" class="btn quiet" id="house-look">Look again</button></div>
              <div id="house-found-rows" class="empty">Loading...</div>
            </div>
            <div class="panel" id="settings-house">
              <div class="plabel">House</div>
              <div class="ptitle">What ${name} may switch</div>
              <div data-group="house" class="empty">Loading...</div>
            </div>
            <div class="panel" id="settings-voice">
              <div class="plabel">Voice list</div>
              <div class="ptitle">What ${name} may control</div>
              <div class="live-note">Choose these in Home Assistant: Settings &gt; Voice assistants &gt; Expose. Aliases set there are names ${name} answers to.</div>
              <div id="voice-list" class="empty">Loading...</div>
            </div>
          </div>
          <div class="panel" id="settings-names">
            <div class="plabel">Names</div>
            <div class="ptitle">What ${name} calls things</div>
            <div class="live-note">Start a name with someone's name, like "${exampleHouseholdName()}'s computer", and "my computer" works when ${exampleHouseholdName()} says it.</div>
            <div class="actions" style="margin: -4px 0 12px"><button type="button" class="btn" id="name-add">Add a name</button></div>
            <div id="name-form-slot"></div>
            <div id="names" class="empty">Loading...</div>
            <datalist id="entity-list"></datalist>
          </div>
        </div>
      </section>
      <section class="view" id="view-system" aria-labelledby="nav-system" hidden>
        <header class="view-head"><h2>System</h2><p>Sign-in and the app itself.</p></header>
        <div class="grid">
          <div class="panel" id="settings-signin">
            <div class="plabel">Sign-in</div>
            <div class="ptitle">${name}'s brain</div>
            <div id="signin-body" class="empty">Loading...</div>
          </div>
          <div class="panel" id="system-panel">
            <div class="plabel">App</div>
            <div class="ptitle">Housemate itself</div>
            <div id="system-body" class="empty">Loading...</div>
          </div>
        </div>
        <div class="panel wide" id="app-options-panel">
          <div class="plabel">Settings</div>
          <div class="ptitle">AI, hearing, voice and the house</div>
          <div class="live-note">Keys are never shown; leave a key blank to keep it. Saving takes a restart of Housemate.</div>
          <div id="app-options" class="empty">Loading...</div>
        </div>
        <div class="panel wide" id="media-apps-panel">
          <div class="plabel">Media apps</div>
          <div class="ptitle">Where ${name} looks up films, shows and requests</div>
          <div class="live-note">Found in your Home Assistant integrations. Type an address to use another; clear it to go back. Takes a restart of Housemate.</div>
          <div id="media-apps" class="empty">Loading...</div>
        </div>
      </section>

      <div id="error" class="error" role="alert"></div>
    </main>
  </div>
  <script>
    var statusText = document.getElementById("status");
    var statusDot = document.getElementById("status-dot");
    var metrics = document.getElementById("metrics");
    var turns = document.getElementById("turns");
    var review = document.getElementById("review");
    var corrections = document.getElementById("corrections");
    var held = document.getElementById("held");
    var proactive = document.getElementById("proactive");
    var proactiveTypes = document.getElementById("proactive-types");
    var stored = document.getElementById("stored");
    var tastes = document.getElementById("tastes");
    var growth = document.getElementById("growth");
    var messages = document.getElementById("messages");
    var draft = document.getElementById("draft");
    var form = document.getElementById("chat-form");
    var send = document.getElementById("send");
    var errorBox = document.getElementById("error");
    var helpersBox = document.getElementById("helpers");
    var VIEWS = ["overview", "chat", "assistant", "people", "memory", "speaking", "house", "system"];
    // Old links (#review, #settings, ".../dashboard-ui/settings") still land somewhere sensible.
    var OLD_VIEWS = { review: "memory", settings: "assistant" };
    var SETTINGS_VIEWS = ["assistant", "memory", "speaking", "house", "system"];
    var EFFORT_LABELS = { low: "Quick", medium: "Normal", high: "Careful", "default": "Auto" };
    var chatSessionKey = "housemate-session-id";
    var chatSessionId = null;
    try { chatSessionId = sessionStorage.getItem(chatSessionKey); } catch (e) {}
    if (!chatSessionId) {
      chatSessionId = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : "dash-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      try { sessionStorage.setItem(chatSessionKey, chatSessionId); } catch (e) {}
    }
    var messagesState = [];
    var settingsState = null;
    var rowNotes = {};
    var busy = {};
    var currentReview = null;
    var tailGeneration = 0;
    var activeTailPath = null;

    function esc(value) {
      return String(value == null ? "" : value)
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }

    function rel(value) {
      if (!value) return "n/a";
      var when = new Date(value).getTime();
      if (Number.isNaN(when)) return String(value);
      var diff = Math.round((Date.now() - when) / 1000);
      if (diff < 60) return diff + "s ago";
      if (diff < 3600) return Math.round(diff / 60) + "m ago";
      if (diff < 86400) return Math.round(diff / 3600) + "h ago";
      return Math.round(diff / 86400) + "d ago";
    }

    // The 5 s refresh must not reset a scrolled list: only write what changed.
    function setHtml(element, html) {
      if (element.lastHtml === html) return;
      element.lastHtml = html;
      element.innerHTML = html;
    }

    function setStatus(text, ok) {
      statusText.textContent = text;
      statusDot.className = "dot " + (ok ? "ok" : "bad");
    }

    function showError(error) {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    }

    async function postJson(path, body) {
      var response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.ok === false) throw new Error(data.error || (path + " failed"));
      return data;
    }

    /* Sections */
    function showView(name, remember) {
      name = OLD_VIEWS[name] || name;
      if (VIEWS.indexOf(name) < 0) name = "overview";
      VIEWS.forEach(function (view) {
        document.getElementById("nav-" + view).setAttribute("aria-current", view === name ? "page" : "false");
        document.getElementById("view-" + view).hidden = view !== name;
      });
      if (remember !== false && window.location.hash !== "#" + name) {
        try { history.replaceState(null, "", "#" + name); } catch (e) {}
      }
      if (SETTINGS_VIEWS.indexOf(name) >= 0) loadSettings();
      if (name === "house") { loadNames(); loadDiscovery(); }
      if (name === "people") { loadPeople(); loadTraining(); }
      if (name === "assistant") { loadPersona(); loadVoiceWords(); }
      if (name === "overview") loadSetup();
      if (name === "system") { loadSystem(); loadAppOptions(); loadMediaApps(); }
      window.scrollTo(0, 0);
    }

    function focusPanel(id) {
      var target = document.getElementById(id);
      if (!target) return;
      showView(target.closest(".view").id.replace("view-", ""));
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.remove("flash");
      window.setTimeout(function () { target.classList.add("flash"); }, 20);
      window.setTimeout(function () { target.classList.remove("flash"); }, 1800);
    }

    document.querySelector(".nav").addEventListener("click", function (event) {
      var item = event.target.closest("[data-view]");
      if (item) showView(item.getAttribute("data-view"));
    });

    function setCount(view, count) {
      document.getElementById("count-" + view).textContent = count ? String(count) : "";
    }

    /* System: the app's own settings, one Save per group */
    var optionsBox = document.getElementById("app-options");
    var optionsState = null;
    var optionsRestart = false;

    function optionInput(field) {
      var id = "opt-" + field.key;
      if (field.kind === "choice") {
        return '<select class="pick" id="' + id + '" data-option="' + field.key + '">' + field.choices.map(function (choice) {
          return '<option value="' + esc(choice.value) + '"' + (choice.value === field.value ? " selected" : "") + '>' + esc(choice.label) + '</option>';
        }).join("") + '</select>';
      }
      if (field.kind === "switch") {
        return '<label class="check-line"><input type="checkbox" id="' + id + '" data-option="' + field.key + '"' + (field.value ? " checked" : "") + '> On</label>';
      }
      if (field.kind === "secret") {
        return '<input type="password" id="' + id + '" data-option="' + field.key + '" autocomplete="off" placeholder="' + (field.hasValue ? "Key kept (type to change)" : "Not set") + '">';
      }
      return '<input type="' + (field.kind === "number" ? "number" : "text") + '" id="' + id + '" data-option="' + field.key + '" autocomplete="off" value="' + esc(field.value === null ? "" : String(field.value)) + '">';
    }

    function renderOptions() {
      optionsBox.className = "";
      optionsBox.innerHTML = optionsState.groups.map(function (group, index) {
        return '<div class="house-block" data-option-group="' + index + '"><div class="house-head"><div class="row-name">' + esc(group.title) + '</div></div>'
          + '<div class="option-grid">' + group.fields.map(function (field) {
            return '<label class="field"><span>' + esc(field.label) + '</span>' + optionInput(field) + (field.help ? '<small>' + esc(field.help) + '</small>' : "") + '</label>';
          }).join("") + '</div>'
          + '<div class="actions block-save" data-option-save hidden><button type="button" class="btn" data-option-button>Save</button></div></div>';
      }).join("") + (optionsRestart ? '<div class="restart-bar" style="margin-top: 12px"><span>Saved. Restart Housemate to use it.</span><button type="button" class="btn" data-restart>Restart Housemate</button></div>' : "");
    }

    async function loadAppOptions() {
      try {
        var response = await fetch("settings/app");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "settings failed");
        optionsState = body;
        renderOptions();
      } catch (error) {
        optionsBox.className = "empty";
        optionsBox.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function showOptionSave(event) {
      var group = event.target.closest("[data-option-group]");
      if (group) group.querySelector("[data-option-save]").hidden = false;
    }
    optionsBox.addEventListener("input", showOptionSave);
    optionsBox.addEventListener("change", showOptionSave);

    optionsBox.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-option-button]");
      if (!button) return;
      var group = button.closest("[data-option-group]");
      var change = {};
      optionsState.groups[Number(group.getAttribute("data-option-group"))].fields.forEach(function (field) {
        var input = group.querySelector('[data-option="' + field.key + '"]');
        change[field.key] = field.kind === "switch" ? input.checked : input.value;
      });
      button.disabled = true;
      try {
        optionsState = await postJson("settings/app", change);
        optionsRestart = true;
        renderOptions();
      } catch (error) {
        button.disabled = false;
        showError(error);
      }
    });

    /* System: media apps */
    var MEDIA_NAMES = { plex: "Plex", radarr: "Radarr (films)", sonarr: "Sonarr (shows)", seerr: "Overseerr / Jellyseerr (requests)" };
    var MEDIA_SOURCE = { own: "set here", home_assistant: "from Home Assistant", none: "not set up" };
    var mediaBox = document.getElementById("media-apps");
    var mediaState = null;

    function renderMediaApps() {
      mediaBox.className = "";
      mediaBox.innerHTML = mediaState.apps.map(function (item) {
        return '<div class="house-block" data-media="' + item.app + '"><div class="house-head"><div class="row-name">' + esc(MEDIA_NAMES[item.app])
          + ' <span class="meta">' + esc(MEDIA_SOURCE[item.source]) + '</span></div></div>'
          + '<div class="field-pair"><input type="text" data-media-url value="' + esc(item.url || "") + '" placeholder="http://192.168.1.10:7878" aria-label="' + esc(MEDIA_NAMES[item.app]) + ' address">'
          + '<input type="password" data-media-key value="" placeholder="' + (item.hasKey ? "Key kept (type to change)" : "Key or token") + '" autocomplete="off" aria-label="' + esc(MEDIA_NAMES[item.app]) + ' key"></div>'
          + '<div class="actions block-save" data-media-save hidden><button type="button" class="btn" data-media-button>Save</button></div></div>';
      }).join("") + (mediaState.restart ? '<div class="restart-bar" style="margin-top: 12px"><span>Saved. Restart Housemate to use it.</span><button type="button" class="btn" data-restart>Restart Housemate</button></div>' : "");
    }

    async function loadMediaApps() {
      try {
        var response = await fetch("settings/media-apps");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "media apps failed");
        mediaState = Object.assign({ restart: mediaState ? mediaState.restart : false }, body);
        renderMediaApps();
      } catch (error) {
        mediaBox.className = "empty";
        mediaBox.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    mediaBox.addEventListener("input", function (event) {
      var block = event.target.closest("[data-media]");
      if (block) block.querySelector("[data-media-save]").hidden = false;
    });

    mediaBox.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-media-button]");
      if (!button) return;
      var block = button.closest("[data-media]");
      button.disabled = true;
      try {
        var body = await postJson("settings/media-apps", {
          app: block.getAttribute("data-media"),
          url: block.querySelector("[data-media-url]").value,
          key: block.querySelector("[data-media-key]").value
        });
        mediaState = Object.assign({ restart: true }, body);
        renderMediaApps();
      } catch (error) {
        button.disabled = false;
        showError(error);
      }
    });

    async function loadSystem() {
      var box = document.getElementById("system-body");
      try {
        var response = await fetch("health");
        var body = await response.json();
        var up = Math.round((body.uptimeMs || 0) / 60000);
        box.className = "";
        box.innerHTML = '<div class="row"><div><div class="row-name">Brain version</div></div><span class="lock">' + esc(body.version) + '</span></div>'
          + '<div class="row"><div><div class="row-name">Running for</div></div><span class="lock">' + esc(up < 120 ? up + " min" : Math.round(up / 60) + " h") + '</span></div>'
          + '<div class="live-note" style="margin: 12px 0">Ports and folders are on the app&#39;s Configuration tab in Home Assistant.</div>'
          + '<button type="button" class="btn quiet" data-restart>Restart Housemate</button>';
      } catch (error) {
        box.textContent = "Could not read the app's status.";
      }
    }

    /* Name & Personality: the house's personality file, saved through the brain. */
    var personaState = null;
    var PERSONA_FIELDS = {
      name: ["name", "pronoun", "aliases", "misheard_as"],
      text: ["character", "turn_mode", "creator", "age_answer", "introductions", "identity"]
    };
    var LIST_SPLIT = { aliases: ",", misheard_as: ",", character: "\\n", introductions: "\\n" };

    function personaForm(kind) { return document.querySelector('[data-persona-form="' + kind + '"]'); }

    function fillPersona(kind, fields) {
      var form = personaForm(kind);
      PERSONA_FIELDS[kind].forEach(function (key) {
        var value = fields[key];
        if (key === "pronoun") {
          form.querySelectorAll("[data-pronoun] button").forEach(function (button) {
            button.setAttribute("aria-checked", String(button.getAttribute("data-value") === value));
          });
          return;
        }
        var input = form.elements[key];
        input.value = Array.isArray(value) ? value.join(LIST_SPLIT[key] === "," ? ", " : "\\n") : String(value || "");
      });
      markPersona(kind);
    }

    function collectPersona(kind) {
      var form = personaForm(kind);
      var out = {};
      PERSONA_FIELDS[kind].forEach(function (key) {
        if (key === "pronoun") {
          var on = form.querySelector('[data-pronoun] button[aria-checked="true"]');
          out.pronoun = on ? on.getAttribute("data-value") : "they";
          return;
        }
        var value = form.elements[key].value;
        out[key] = LIST_SPLIT[key]
          ? value.split(LIST_SPLIT[key]).map(function (line) { return line.trim(); }).filter(Boolean)
          : value.trim();
      });
      return out;
    }

    function savedPersona(kind) {
      var out = {};
      PERSONA_FIELDS[kind].forEach(function (key) { out[key] = personaState.fields[key]; });
      return out;
    }

    function markPersona(kind) {
      if (!personaState) return;
      var form = personaForm(kind);
      form.classList.toggle("dirty", JSON.stringify(collectPersona(kind)) !== JSON.stringify(savedPersona(kind)));
    }

    function personaNote(kind, text, tone) {
      var note = personaForm(kind).querySelector(".form-note");
      note.textContent = text || "";
      note.className = "form-note" + (tone ? " " + tone : "");
    }

    var voiceWordsPending = false;
    function showRestartBar(on) {
      document.getElementById("restart-bar").hidden = !(on || voiceWordsPending || (personaState && personaState.restartPending));
    }

    var voiceWordsForm = document.getElementById("voice-words");
    function voiceWordsNote(text, tone) {
      var note = voiceWordsForm.querySelector(".form-note");
      note.textContent = text || "";
      note.className = "form-note" + (tone ? " " + tone : "");
    }
    function fillVoiceWords(words) {
      ["greeting", "goodbye", "stop_phrase"].forEach(function (key) { voiceWordsForm.elements[key].value = words[key] || ""; });
    }
    async function loadVoiceWords() {
      try {
        var response = await fetch("settings/voice-words");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "spoken words failed");
        if (!voiceWordsForm.classList.contains("dirty")) fillVoiceWords(body.words);
        voiceWordsPending = body.restartPending;
        showRestartBar(false);
      } catch (error) {
        showError(error);
      }
    }
    voiceWordsForm.addEventListener("input", function () { voiceWordsForm.classList.add("dirty"); voiceWordsNote(""); });
    voiceWordsForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = voiceWordsForm.querySelector('button[type="submit"]');
      button.disabled = true;
      voiceWordsNote("Saving...");
      try {
        var body = await postJson("settings/voice-words", {
          greeting: voiceWordsForm.elements.greeting.value,
          goodbye: voiceWordsForm.elements.goodbye.value,
          stop_phrase: voiceWordsForm.elements.stop_phrase.value
        });
        voiceWordsForm.classList.remove("dirty");
        fillVoiceWords(body.words);
        voiceWordsPending = body.restartPending;
        voiceWordsNote("Saved. Takes effect after a restart.", "ok");
        showRestartBar(false);
      } catch (error) {
        voiceWordsNote(error instanceof Error ? error.message : String(error), "bad");
      } finally {
        button.disabled = false;
      }
    });

    async function loadPersona() {
      try {
        var response = await fetch("settings/persona");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "personality failed");
        personaState = body;
        ["name", "text"].forEach(function (kind) {
          if (!personaForm(kind).classList.contains("dirty")) fillPersona(kind, body.fields);
        });
        showRestartBar(body.restartPending);
      } catch (error) {
        showError(error);
      }
    }

    document.querySelectorAll("[data-persona-form]").forEach(function (form) {
      var kind = form.getAttribute("data-persona-form");
      form.addEventListener("input", function () { personaNote(kind, ""); markPersona(kind); });
      form.addEventListener("click", function (event) {
        var pronoun = event.target.closest("[data-pronoun] button");
        if (pronoun) {
          form.querySelectorAll("[data-pronoun] button").forEach(function (button) {
            button.setAttribute("aria-checked", String(button === pronoun));
          });
          personaNote(kind, "");
          markPersona(kind);
          return;
        }
        if (event.target.closest("[data-persona-undo]") && personaState) {
          fillPersona(kind, personaState.fields);
          personaNote(kind, "");
          return;
        }
        if (event.target.closest("[data-persona-defaults]") && personaState) {
          fillPersona(kind, Object.assign({}, personaState.fields, personaState.defaults));
          personaNote(kind, "Defaults filled in. Save to keep them.");
        }
      });
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        personaNote(kind, "Saving...");
        try {
          var body = await postJson("settings/persona", collectPersona(kind));
          personaState = body;
          fillPersona(kind, body.fields);
          personaNote(kind, body.applied === "live" ? "Saved. Live now." : "Saved. Takes effect after a restart.", "ok");
          showRestartBar(body.restartPending);
        } catch (error) {
          personaNote(kind, error instanceof Error ? error.message : String(error), "bad");
        } finally {
          button.disabled = false;
        }
      });
    });

    document.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-restart]");
      if (!button) return;
      if (!window.confirm("Restart Housemate? Voice and chat stop for about a minute.")) return;
      var before = null;
      try { before = (await (await fetch("health")).json()).startedAt; } catch (e) {}
      try {
        await postJson("system/restart", {});
      } catch (error) {
        showError(error);
        return;
      }
      document.querySelectorAll("[data-restart]").forEach(function (each) { each.disabled = true; each.textContent = "Restarting..."; });
      setStatus("restarting", false);
      var tries = 0;
      var timer = window.setInterval(async function () {
        tries += 1;
        try {
          var health = await (await fetch("health")).json();
          if (health.startedAt && health.startedAt !== before) { window.clearInterval(timer); window.location.reload(); }
        } catch (e) {}
        if (tries > 100) { window.clearInterval(timer); setStatus("restart is taking long; reload the page", false); }
      }, 3000);
    });

    /* People: who lives here, each linked by hand to a Home Assistant person. */
    var peopleState = null;
    var peopleDraft = [];
    var peopleEditing = -1;
    var ROLE_LABELS = { owner: "Runs the house", adult: "Adult", child: "Child" };
    var PRONOUN_LABELS = { he: "he/him", she: "she/her", they: "they/them" };
    var PRONOUN_OPTIONS = { he: "He", she: "She", they: "They" };

    function peopleDirty() {
      return Boolean(peopleState) && JSON.stringify(peopleDraft) !== JSON.stringify(peopleState.people);
    }

    function haName(id) {
      var found = (peopleState.haPersons || []).find(function (each) { return each.id === id; });
      return found ? (found.name || found.id) : id;
    }

    function segHtml(group, options, current) {
      return '<div class="seg" role="radiogroup" data-person-seg="' + group + '">' + Object.keys(options).map(function (key) {
        return '<button type="button" role="radio" data-value="' + key + '" aria-checked="' + String(key === current) + '">' + esc(options[key]) + '</button>';
      }).join("") + '</div>';
    }

    function linkHtml(person, index) {
      var options = '<option value="">Not linked</option>' + (peopleState.haPersons || []).map(function (each) {
        var holder = peopleDraft.findIndex(function (other, at) { return at !== index && other.ha_person === each.id; });
        return '<option value="' + esc(each.id) + '"' + (person.ha_person === each.id ? " selected" : "") + (holder >= 0 ? " disabled" : "") + '>'
          + esc((each.name || each.id) + " (" + each.id + ")" + (holder >= 0 ? " - linked to " + (peopleDraft[holder].name || "someone") : "")) + '</option>';
      }).join("");
      return '<label class="field"><span>Home Assistant person</span><select data-person-field="ha_person">' + options + '</select>'
        + '<small>Who this is in Home Assistant. One Home Assistant person per person here.</small></label>';
    }

    function personHtml(person, index) {
      var editing = peopleEditing === index;
      var trained = trainingState && trainingState.status && (trainingState.status.trained || []).indexOf(person.id) >= 0;
      var meta = ROLE_LABELS[person.role] + " · " + PRONOUN_LABELS[person.pronoun]
        + " · " + (person.ha_person ? "linked to " + haName(person.ha_person) : "not linked")
        + " · " + (trained ? "voice trained" : "no voice yet");
      var html = '<div class="person' + (editing ? " editing" : "") + '" data-person="' + index + '">'
        + '<div class="person-head"><div><div class="person-name">' + esc(person.name || "New person") + '</div><div class="person-meta">' + esc(meta) + '</div></div>'
        + '<div class="person-actions">'
        + '<button type="button" class="btn quiet" data-person-edit>' + (editing ? "Done" : "Edit") + '</button>'
        + '<button type="button" class="btn quiet" data-person-train' + (person.id && !peopleDirty() ? "" : ' disabled title="Save People first"') + '>Train voice</button>'
        + '<button type="button" class="btn quiet" data-person-remove>Remove</button>'
        + '</div></div>';
      if (editing) {
        html += '<div class="person-body">'
          + linkHtml(person, index)
          + '<div class="field-pair">'
          + '<label class="field"><span>Name</span><input type="text" data-person-field="name" maxlength="40" value="' + esc(person.name) + '"></label>'
          + '<label class="field"><span>Short name</span><input type="text" data-person-field="short_name" maxlength="40" value="' + esc(person.short_name) + '" placeholder="Optional, like Sam for Samantha"></label>'
          + '</div>'
          + '<div class="field"><span>Pronoun</span>' + segHtml("pronoun", PRONOUN_OPTIONS, person.pronoun) + '</div>'
          + '<div class="field"><span>Role</span>' + segHtml("role", ROLE_LABELS, person.role) + '<small>One person runs the house: they approve memories. Children get child-safe answers.</small></div>'
          + '<label class="field"><span>Nicknames</span><input type="text" data-person-field="aliases" value="' + esc(person.aliases.join(", ")) + '" placeholder="Separate with commas"></label>'
          + '<label class="field"><span>Often misheard as</span><input type="text" data-person-field="misheard_as" value="' + esc(person.misheard_as.join(", ")) + '" placeholder="Separate with commas"></label>'
          + (person.id ? '<small class="hint">Memory id ' + esc(person.id) + ' (never changes). Renaming keeps their memories and their trained voice.</small>' : "")
          + '</div>';
      }
      return html + '</div>';
    }

    function renderPeople() {
      var list = document.getElementById("people-list");
      if (!peopleState) return;
      list.className = "people" + (peopleDirty() ? " dirty" : "");
      list.innerHTML = peopleDraft.length
        ? peopleDraft.map(personHtml).join("")
        : '<div class="empty">Nobody yet. Add the people who live here; everyone else is treated as a guest.</div>';
      document.getElementById("people-restart").hidden = !peopleState.restartPending;
    }

    function peopleNote(text, tone) {
      var note = document.getElementById("people-note");
      note.textContent = text || "";
      note.className = "form-note" + (tone ? " " + tone : "");
    }

    async function loadPeople() {
      try {
        var response = await fetch("settings/people");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "people failed");
        var dirty = peopleDirty();
        peopleState = body;
        if (!dirty) peopleDraft = JSON.parse(JSON.stringify(body.people));
        renderPeople();
      } catch (error) {
        showError(error);
      }
    }

    function changed() {
      peopleNote("");
      document.getElementById("people-list").classList.toggle("dirty", peopleDirty());
    }

    var peoplePanel = document.getElementById("people-panel");
    peoplePanel.addEventListener("input", function (event) {
      var input = event.target.closest("input[data-person-field]");
      if (!input) return;
      var person = peopleDraft[Number(input.closest("[data-person]").getAttribute("data-person"))];
      var key = input.getAttribute("data-person-field");
      person[key] = key === "aliases" || key === "misheard_as"
        ? input.value.split(",").map(function (word) { return word.trim(); }).filter(Boolean)
        : input.value;
      changed();
    });
    peoplePanel.addEventListener("change", function (event) {
      var select = event.target.closest("select[data-person-field]");
      if (!select) return;
      var person = peopleDraft[Number(select.closest("[data-person]").getAttribute("data-person"))];
      person.ha_person = select.value;
      if (select.value && !person.name.trim()) person.name = haName(select.value);
      changed();
      renderPeople();
    });
    peoplePanel.addEventListener("click", function (event) {
      var row = event.target.closest("[data-person]");
      var index = row ? Number(row.getAttribute("data-person")) : -1;
      var person = index >= 0 ? peopleDraft[index] : null;
      var seg = event.target.closest("[data-person-seg] button");
      if (seg && person) {
        var group = seg.closest("[data-person-seg]").getAttribute("data-person-seg");
        var value = seg.getAttribute("data-value");
        if (group === "role" && value === "owner") {
          peopleDraft.forEach(function (other) { if (other.role === "owner") other.role = "adult"; });
        }
        person[group] = value;
        changed();
        renderPeople();
        return;
      }
      if (event.target.closest("[data-person-train]") && person) {
        openTraining(person);
        return;
      }
      if (event.target.closest("[data-person-edit]") && person) {
        peopleEditing = peopleEditing === index ? -1 : index;
        renderPeople();
        return;
      }
      if (event.target.closest("[data-person-remove]") && person) {
        if (!window.confirm("Remove " + (person.name || "this person") + " from the household? Their memories stay, but they will be treated as a guest.")) return;
        peopleDraft.splice(index, 1);
        peopleEditing = -1;
        changed();
        renderPeople();
        return;
      }
      if (event.target.closest("[data-people-add]")) {
        peopleDraft.push({
          id: "", ha_person: "", name: "", short_name: "", pronoun: "they",
          role: peopleDraft.some(function (each) { return each.role === "owner"; }) ? "adult" : "owner",
          aliases: [], misheard_as: []
        });
        peopleEditing = peopleDraft.length - 1;
        changed();
        renderPeople();
        return;
      }
      if (event.target.closest("[data-people-undo]")) {
        peopleDraft = JSON.parse(JSON.stringify(peopleState.people));
        peopleEditing = -1;
        peopleNote("");
        renderPeople();
        return;
      }
      if (event.target.closest("[data-people-save]")) savePeople(event.target.closest("[data-people-save]"));
    });

    async function savePeople(button) {
      button.disabled = true;
      peopleNote("Saving...");
      try {
        var body = await postJson("settings/people", { people: peopleDraft });
        peopleState = body;
        peopleDraft = JSON.parse(JSON.stringify(body.people));
        peopleEditing = -1;
        renderPeople();
        peopleNote("Saved.", "ok");
      } catch (error) {
        peopleNote(error instanceof Error ? error.message : String(error), "bad");
      } finally {
        button.disabled = false;
      }
    }

    /* Voice training: the speaker runs the sentences; the page shows how far it is. */
    var trainingState = null;
    var trainingPerson = null;
    var trainingTimer = null;
    var TRAINING_ACTIVE = ["recording", "training"];

    async function loadTraining() {
      try {
        var response = await fetch("voice-training");
        if (!response.ok) return;
        trainingState = await response.json();
        renderTraining();
        renderPeople();
      } catch (e) {}
    }

    function openTraining(person) {
      trainingPerson = person;
      document.getElementById("training-panel").hidden = false;
      document.getElementById("training-setup").hidden = false;
      document.getElementById("training-run").hidden = true;
      document.getElementById("training-title").textContent = "Train " + person.name + "'s voice";
      document.getElementById("training-note").textContent = "";
      var satellites = trainingState ? trainingState.satellites || [] : [];
      var select = document.getElementById("training-satellite");
      select.innerHTML = satellites.map(function (each) {
        return '<option value="' + esc(each.entityId) + '">' + esc(each.name + " (wake word: " + each.wakeWord + ")") + '</option>';
      }).join("");
      document.querySelector("[data-training-start]").disabled = !satellites.length;
      if (!satellites.length) document.getElementById("training-note").textContent = "No speaker here can run training: it must be a Home Assistant voice satellite.";
      document.getElementById("training-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function renderTraining() {
      var status = trainingState && trainingState.status ? trainingState.status : { state: "idle" };
      var running = TRAINING_ACTIVE.indexOf(status.state) >= 0;
      var shown = running || (trainingPerson && status.person_id === trainingPerson.id && status.state !== "idle");
      if (!shown) return;
      document.getElementById("training-panel").hidden = false;
      document.getElementById("training-setup").hidden = true;
      document.getElementById("training-run").hidden = false;
      document.getElementById("training-title").textContent = "Training " + (status.name || "a") + "'s voice";
      var share = status.state === "recording" ? ((status.sentence || 1) - 1) / (status.total || 10)
        : status.state === "training" ? status.progress || 0 : status.state === "complete" ? 1 : 0;
      document.getElementById("training-bar").style.width = Math.round(share * 100) + "%";
      document.querySelector("#training-panel .progress").setAttribute("aria-valuenow", String(Math.round(share * 100)));
      var text = {
        recording: "Sentence " + status.sentence + " of " + status.total + ". Listen to the speaker and repeat after the beep.",
        training: "Learning the voice... " + Math.round((status.progress || 0) * 100) + "%",
        complete: "Complete. " + (status.message || ""),
        failed: status.message || "Training stopped.",
        cancelled: "Stopped. Nothing was saved."
      }[status.state] || status.message || "";
      document.getElementById("training-text").textContent = text;
      document.querySelector("[data-training-cancel]").hidden = !running;
      document.querySelector("#training-run [data-training-close]").hidden = running;
      if (running && !trainingTimer) {
        trainingTimer = window.setInterval(loadTraining, 1500);
      } else if (!running && trainingTimer) {
        window.clearInterval(trainingTimer);
        trainingTimer = null;
      }
    }

    document.getElementById("training-panel").addEventListener("click", async function (event) {
      if (event.target.closest("[data-training-close]")) {
        document.getElementById("training-panel").hidden = true;
        trainingPerson = null;
        return;
      }
      if (event.target.closest("[data-training-cancel]")) {
        try { await postJson("voice-training/cancel", {}); } catch (error) { showError(error); }
        loadTraining();
        return;
      }
      var start = event.target.closest("[data-training-start]");
      if (!start || !trainingPerson) return;
      var trained = trainingState && trainingState.status && (trainingState.status.trained || []).indexOf(trainingPerson.id) >= 0;
      if (trained && !window.confirm("This replaces " + trainingPerson.name + "'s current voice with a new one. Go ahead?")) return;
      start.disabled = true;
      document.getElementById("training-note").textContent = "Starting...";
      try {
        var body = await postJson("voice-training/start", { person_id: trainingPerson.id, satellite: document.getElementById("training-satellite").value });
        trainingState = Object.assign({}, trainingState, { status: body.status });
        renderTraining();
      } catch (error) {
        document.getElementById("training-note").textContent = error instanceof Error ? error.message : String(error);
      } finally {
        start.disabled = false;
      }
    });

    /* First run: what is left to set up, from the house's own files; gone when done. */
    var SETUP_STEPS = {
      assistant: { title: "Name your assistant", help: "Pick a name, pronoun and personality.", view: "assistant", button: "Assistant" },
      people: { title: "Add who lives here", help: "Add each person, link them to their Home Assistant person, and pick who runs the house.", view: "people", button: "People" },
      brain: { title: "Sign in the brain", help: "Claude or Codex, with your own account. Pick which in System, Settings.", view: "system", button: "System" },
      assist: { title: "Add Housemate Brain to Home Assistant", help: "Install Housemate Brain from HACS and restart Home Assistant, then add it under Settings > Devices & services. In Settings > Voice assistants, pick it as the conversation agent, with ${name} Hearing and ${name} Voice.", view: "", button: "" }
    };

    async function loadSetup() {
      try {
        var response = await fetch("setup");
        if (!response.ok) return;
        var body = await response.json();
        var panel = document.getElementById("setup-panel");
        panel.hidden = body.complete;
        if (body.complete) return;
        document.getElementById("setup-steps").innerHTML = body.steps.map(function (step) {
          var info = SETUP_STEPS[step.id];
          return '<li class="step' + (step.done ? " done" : "") + '">'
            + '<span class="tick" aria-hidden="true">' + (step.done ? "&#10003;" : "") + '</span>'
            + '<div><div class="row-name">' + esc(info.title) + (step.done ? ' <span class="meta">done</span>' : "") + '</div>'
            + '<div class="row-help">' + esc(info.help) + '</div></div>'
            + (info.view && !step.done ? '<button type="button" class="btn quiet" data-view-jump="' + info.view + '">' + esc(info.button) + '</button>' : "<span></span>")
            + '</li>';
        }).join("");
      } catch (e) {}
    }

    document.getElementById("setup-panel").addEventListener("click", function (event) {
      var jump = event.target.closest("[data-view-jump]");
      if (jump) showView(jump.getAttribute("data-view-jump"));
    });

    /* Chat and review */
    function renderMessages() {
      if (!messagesState.length) {
        messages.innerHTML = '<div class="empty">Ask ${name} something from here.</div>';
        return;
      }
      messages.innerHTML = messagesState.slice(-6).map(function (message) {
        return '<div class="bubble ' + (message.role === "You" ? "me" : "") + '">'
          + '<div class="label">' + esc(message.role) + '</div>'
          + '<div class="line">' + esc(message.text) + '</div>'
          + (message.meta ? '<div class="meta">' + esc(message.meta) + '</div>' : "")
          + '</div>';
      }).join("");
    }

    function renderDashboard(body) {
      var report = body && body.report ? body.report : null;
      var latest = report && report.latency ? report.latency.latest : null;
      setStatus("live", true);
      var heldCount = body && body.heldMemories ? body.heldMemories.items.length : 0;
      var openCorrections = body && body.corrections ? body.corrections.open : 0;
      var reviewRemaining = body && body.review ? (body.review.remaining || 0) : 0;
      var proactiveWaiting = body && body.proactiveReview ? body.proactiveReview.waiting : 0;
      setCount("memory", heldCount + openCorrections + reviewRemaining);
      setCount("speaking", proactiveWaiting);
      metrics.innerHTML = [
        { label: "Latest Route", value: latest ? latest.route : "n/a", note: latest ? latest.outcome + " · " + latest.latencyMs + " ms" : "No turns yet", target: "turns-panel" },
        { label: "Turns", value: report ? String(report.latency.turnCount) : "0", note: report && report.latency.averageMs != null ? "avg " + Math.round(report.latency.averageMs) + " ms" : "No latency yet", target: "turns-panel" },
        { label: "Memories To Check", value: String(heldCount), note: body && body.heldMemories && !body.heldMemories.enabled ? "Memory off" : "Keep or scrap", target: "held-panel" },
        { label: "Corrections", value: String(openCorrections), note: body && body.corrections && !body.corrections.enabled ? "List off" : "Open", target: "corrections-panel" },
        { label: "Review Queue", value: String(reviewRemaining), note: "Memory review items", target: "review-panel" }
      ].map(function (item) {
        return '<button type="button" class="card" data-target="' + esc(item.target) + '" aria-label="Jump to ' + esc(item.label) + '">'
          + '<div class="label">' + esc(item.label) + '</div>'
          + '<div class="value">' + esc(item.value) + '</div>'
          + '<div class="note">' + esc(item.note) + '</div>'
          + '</button>';
      }).join("");

      var turnItems = body && body.recentTurns ? body.recentTurns : [];
      turns.innerHTML = turnItems.length ? turnItems.map(function (turn) {
        return '<div class="item"><div class="head">'
          + '<span class="route">' + esc(turn.route) + '</span>'
          + '<span class="meta">' + esc(turn.outcome) + ' · ' + esc(rel(turn.timestamp)) + '</span></div>'
          + '<div class="line">' + esc(turn.transcript || "No transcript") + '</div>'
          + '<div class="line answer">' + esc(turn.responseText || "No response text") + '</div>'
          + (turn.explanation ? '<div class="meta">why: ' + esc(turn.explanation.reason) + '</div>' : "")
          + (turn.explanation && turn.explanation.sourceLabels && turn.explanation.sourceLabels.length ? '<div class="meta">sources: ' + esc(turn.explanation.sourceLabels.join(", ")) + '</div>' : "")
          + '</div>';
      }).join("") : '<div class="empty">No turns logged yet.</div>';

      var correctionItems = body && body.corrections ? body.corrections.items : [];
      corrections.innerHTML = correctionItems.length ? correctionItems.map(function (entry) {
        return '<div class="item"><div class="head">'
          + '<span class="route">' + esc(entry.corrected ? entry.corrected.route : "no linked answer") + '</span>'
          + '<span class="meta">' + esc(entry.speaker) + ' · ' + esc(rel(entry.correction.timestamp)) + '</span></div>'
          + (entry.corrected ? '<div class="line">' + esc(entry.corrected.transcript) + '</div><div class="line answer">' + esc(entry.corrected.responseText) + '</div>' : "")
          + '<div class="line">Correction: ' + esc(entry.correction.transcript) + '</div>'
          + (entry.correctedText ? '<div class="meta">meant: ' + esc(entry.correctedText) + '</div>' : "")
          + '<div class="actions">'
          + '<button type="button" class="btn" data-correction="' + esc(entry.id) + '" data-reason="fixed">Fixed</button>'
          + '<button type="button" class="btn quiet" data-correction="' + esc(entry.id) + '" data-reason="not_a_correction">Not a correction</button>'
          + '</div></div>';
      }).join("") : '<div class="empty">No open corrections.</div>';

      var heldItems = body && body.heldMemories ? body.heldMemories.items : [];
      held.innerHTML = heldItems.length ? heldItems.map(function (item) {
        return '<div class="item"><div class="head">'
          + '<span class="route">' + esc(item.speaker) + '</span>'
          + '<span class="meta">' + esc(rel(item.createdAt)) + '</span></div>'
          + '<div class="line">' + esc(item.statement) + '</div>'
          + '<div class="meta">said: "' + esc(item.quote) + '"</div>'
          + '<div class="actions">'
          + '<button type="button" class="btn" data-held="' + esc(item.id) + '" data-verdict="keep">Keep</button>'
          + '<button type="button" class="btn quiet" data-held="' + esc(item.id) + '" data-verdict="bin">Scrap</button>'
          + '</div></div>';
      }).join("") : (body && body.heldMemories && !body.heldMemories.enabled
        ? '<div class="empty">Memory reflection is off.</div>'
        : '<div class="empty">Nothing waiting.</div>');

      var proactiveBody = body ? body.proactiveReview : null;
      var proactiveItems = proactiveBody ? proactiveBody.items : [];
      setHtml(proactive, proactiveItems.length ? proactiveItems.map(function (item) {
        var verdict = { good: "Accepted", bad: "Declined", badly_timed: "Declined: bad timing" }[item.rating];
        var typeRow = (proactiveBody.types || []).find(function (row) { return row.type === item.opportunityType; });
        return '<div class="item' + (item.kind === "held" ? ' held' : '') + '"><div class="head">'
          + '<span class="route">' + esc(typeRow ? typeRow.label : item.opportunityType.replaceAll("_", " ")) + '</span>'
          + '<span class="meta">' + esc(rel(item.timestamp)) + '</span></div>'
          + '<div class="line answer">' + esc(item.proposedText) + '</div>'
          + '<div class="meta">' + esc(item.why) + '</div>'
          + (item.kind === "held" ? '' : verdict
            ? '<div class="meta">' + esc(verdict) + ' · ' + esc(rel(item.decidedAt)) + '</div>'
            : '<div class="actions">'
              + '<button type="button" class="btn" data-proactive="' + esc(item.id) + '" data-verdict="accept">Accept</button>'
              + '<button type="button" class="btn quiet" data-proactive="' + esc(item.id) + '" data-verdict="decline">Decline</button>'
              + '</div>')
          + '</div>';
      }).join("") : '<div class="empty">' + (proactiveBody && !proactiveBody.enabled ? "Proactive thinking is off." : "Nothing ${name} would have said yet.") + '</div>');
      var typeRows = proactiveBody ? proactiveBody.types : [];
      setHtml(proactiveTypes, typeRows.length ? typeRows.map(function (row) {
        var counts = row.accepted || row.declined ? row.accepted + " accepted · " + row.declined + " declined" : "Nothing reviewed yet";
        return '<div class="row"><div><div class="row-name">' + esc(row.label) + '</div><div class="row-help">' + esc(counts) + '</div></div>'
          + '<button type="button" class="switch" role="switch" aria-checked="' + String(row.on) + '" aria-label="' + esc(row.label) + '" data-idea-type="' + esc(row.type) + '"' + (busy["idea:" + row.type] ? " disabled" : "") + '></button></div>';
      }).join("") : '<div class="empty">Not loaded.</div>');

      var storedItems = body && body.storedMemories ? body.storedMemories.items : [];
      setHtml(stored, storedItems.length ? storedItems.map(function (item) {
        return '<div class="item"><div class="head">'
          + '<span class="route">' + esc(item.title) + '</span>'
          + '<span class="meta">' + esc(item.category) + ' · ' + esc(rel(item.updatedAt)) + '</span></div>'
          + '<div class="line">' + esc(item.summary) + '</div>'
          + '<div class="actions small"><button type="button" class="btn quiet" data-scrap="' + esc(item.id) + '" data-title="' + esc(item.title) + '">Scrap</button></div>'
          + '</div>';
      }).join("") : '<div class="empty">' + (body && body.storedMemories && !body.storedMemories.enabled ? "Memory recall is off." : "Nothing stored.") + '</div>');

      var tasteBody = body ? body.tastes : null;
      if (!tasteBody) {
        setHtml(tastes, '<div class="empty">Tastes are not loaded.</div>');
      } else {
        var tasteItems = tasteBody.items.slice().sort(function (a, b) {
          return (Number(b.canUndo) - Number(a.canUndo)) || (Number(b.locked) - Number(a.locked)) || a.subject.localeCompare(b.subject);
        });
        setHtml(tastes, '<div class="sub">Opinions from chat</div>'
          + (tasteBody.opinions.length ? tasteBody.opinions.map(function (item) {
            return '<div class="item"><div class="head"><span class="route">' + esc(item.subject) + '</span></div>'
              + '<div class="line answer">' + esc(item.stance) + '</div>'
              + '<div class="actions small"><button type="button" class="btn quiet" data-opinion="' + esc(item.id) + '" data-title="' + esc(item.subject) + '">Forget</button></div>'
              + '</div>';
          }).join("") : '<div class="empty">No chat opinions.</div>')
          + '<div class="sub">Tastes</div>'
          + tasteItems.map(function (item) {
            return '<div class="item"><div class="head"><span class="route">' + esc(item.subject) + '</span>'
              + '<span class="meta">' + esc(item.category) + (item.locked ? ' · locked' : '') + '</span></div>'
              + '<div class="line answer">' + esc(item.stance) + '</div>'
              + '<div class="actions small">'
              + (item.canUndo ? '<button type="button" class="btn" data-taste="' + esc(item.id) + '" data-action="rollback">Undo</button>' : '')
              + '<button type="button" class="btn quiet" data-taste="' + esc(item.id) + '" data-action="' + (item.locked ? 'unlock' : 'lock') + '">' + (item.locked ? 'Unlock' : 'Lock') + '</button>'
              + '</div></div>';
          }).join(""));
      }

      renderGrowth(body ? body.growth : null);

      currentReview = body && body.review ? body.review.item : null;
      setHtml(review, currentReview
        ? '<div class="item"><div class="head">'
          + '<span class="route">' + esc(currentReview.memory && (currentReview.memory.title || currentReview.memory.id) || "Queued memory") + '</span>'
          + '<span class="meta">' + esc(currentReview.memory && currentReview.memory.reviewStatus || "queued") + '</span></div>'
          + '<div class="line">' + esc(currentReview.memory && currentReview.memory.summary || "No summary") + '</div>'
          + '<div class="actions small">' + [["approve", "Accept", ""], ["edit", "Edit", " quiet"], ["ignore", "Ignore", " quiet"], ["delete", "Delete", " quiet"], ["redact", "Redact", " quiet"]].map(function (action) {
            return '<button type="button" class="btn' + action[2] + '" data-review-action="' + action[0] + '">' + action[1] + '</button>';
          }).join("") + '</div></div>'
        : '<div class="empty">Review queue clear.</div>');
    }

    async function loadDashboard() {
      try {
        var response = await fetch("dashboard?turns=8");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "dashboard failed");
        renderDashboard(body);
      } catch (error) {
        setStatus("error", false);
        showError(error);
      }
    }

    corrections.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-correction]");
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        await postJson("corrections/close", { id: button.getAttribute("data-correction"), reason: button.getAttribute("data-reason") });
        errorBox.textContent = "";
        await loadDashboard();
      } catch (error) {
        button.disabled = false;
        showError(error);
      }
    });

    held.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-held]");
      if (!button || button.disabled) return;
      var item = button.closest(".item");
      item.querySelectorAll("button").forEach(function (each) { each.disabled = true; });
      try {
        await postJson("memory/held/decide", { id: button.getAttribute("data-held"), verdict: button.getAttribute("data-verdict") });
        errorBox.textContent = "";
        await loadDashboard();
      } catch (error) {
        item.querySelectorAll("button").forEach(function (each) { each.disabled = false; });
        showError(error);
      }
    });

    proactiveTypes.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-idea-type]");
      if (!button || button.disabled) return;
      var type = button.getAttribute("data-idea-type");
      busy["idea:" + type] = true;
      button.disabled = true;
      try {
        await postJson("proactive/types", { type: type, on: button.getAttribute("aria-checked") !== "true" });
        errorBox.textContent = "";
      } catch (error) {
        showError(error);
      } finally {
        delete busy["idea:" + type];
        await loadDashboard();
      }
    });

    proactive.addEventListener("click", function (event) {
      var button = event.target.closest("[data-proactive]");
      if (!button || button.disabled) return;
      reviewAction(button, "proactive/review/decide", { id: button.getAttribute("data-proactive"), verdict: button.getAttribute("data-verdict") });
    });

    async function reviewAction(button, path, payload) {
      var item = button.closest(".item");
      item.querySelectorAll("button").forEach(function (each) { each.disabled = true; });
      try {
        await postJson(path, payload);
        errorBox.textContent = "";
        await loadDashboard();
      } catch (error) {
        item.querySelectorAll("button").forEach(function (each) { each.disabled = false; });
        showError(error);
      }
    }

    // The memory review queue (only memories marked needs_clarification reach it now).
    review.addEventListener("click", function (event) {
      var button = event.target.closest("[data-review-action]");
      if (!button || button.disabled || !currentReview) return;
      var action = button.getAttribute("data-review-action");
      var memory = currentReview.memory || {};
      var payload = { reviewId: currentReview.reviewId, action: action };
      if ((action === "delete" || action === "redact") && !window.confirm(button.textContent + ' "' + (memory.title || memory.id) + '"?')) return;
      if (action === "edit") {
        var summary = window.prompt("Correct summary", memory.summary || "");
        if (summary === null) return;
        payload.summary = summary;
        var payloadType = memory.payload ? memory.payload.category : "";
        var value = payloadType === "preference" ? window.prompt("Correct preference value", String(memory.payload.value || "")) : "";
        var outcome = payloadType === "episodic" ? window.prompt("Correct episode outcome", String(memory.payload.outcome || "")) : "";
        var occurredAt = payloadType === "episodic" && outcome !== null ? window.prompt("Correct occurrence time (canonical UTC ISO-8601)", String(memory.payload.occurredAt || "")) : "";
        if (value === null || outcome === null || occurredAt === null) return;
        if (value) payload.value = value;
        if (outcome) payload.outcome = outcome;
        if (occurredAt) payload.occurredAt = occurredAt;
      }
      reviewAction(button, "memory/review/decision", payload);
    });

    stored.addEventListener("click", function (event) {
      var button = event.target.closest("[data-scrap]");
      if (!button || button.disabled) return;
      if (!window.confirm('Scrap "' + button.getAttribute("data-title") + '"? ${name} will stop using it.')) return;
      reviewAction(button, "memory/remove", { memoryId: button.getAttribute("data-scrap"), action: "delete" });
    });

    /* The assistant's versions with what each night changed and why, its habits, and the last fortnight of nights. */
    function renderGrowth(data) {
      if (!data) {
        setHtml(growth, '<div class="empty">Growth is not loaded.</div>');
        return;
      }
      var CHANGE = { add: "Added", replace: "Changed", remove: "Dropped" };
      var SOURCE = { seed: "as written", nightly: "nightly", rollback: "rolled back" };
      setHtml(growth, '<div class="line">' + (data.enabled
          ? "On: each night at 9:30 ${name} may change a little, from the day's chats."
          : "Off: ${name} stays as SELF.md says. Switch it on under Settings.") + '</div>'
        + '<div class="sub">Who ${name} is</div>'
        + data.versions.map(function (version) {
          return '<div class="item"><div class="head"><span class="route">Version ' + esc(version.version) + (version.version === data.current ? " · now" : "") + '</span>'
            + '<span class="meta">' + esc(rel(version.writtenAt)) + ' · ' + esc(SOURCE[version.source] || version.source)
            + (version.wordsChanged ? ' · ' + esc(version.wordsChanged) + ' words' : '') + '</span></div>'
            + '<div class="line">' + esc(version.reason) + '</div>'
            + version.changes.map(function (change) {
              return '<div class="line answer">' + esc(CHANGE[change.op] || change.op) + ' (' + esc(change.section) + '): '
                + esc(change.op === "remove" ? change.before : change.after) + '</div>';
            }).join("")
            + (version.version === data.current ? '' : '<div class="actions small"><button type="button" class="btn quiet" data-growth-rollback="' + esc(version.version) + '">Roll back to this</button></div>')
            + '</div>';
        }).join("")
        + '<div class="sub">How ${name} talks</div>'
        + (data.habits.length ? data.habits.map(function (habit) {
          return '<div class="item"><div class="head"><span class="route">"' + esc(habit.phrase) + '"</span>'
            + '<span class="meta">' + (habit.fromWho === "them" ? "picked up from you" : "${their} own") + ' · used ' + esc(rel(habit.lastSeen)) + '</span></div>'
            + '<div class="line answer">' + esc(habit.note) + '</div>'
            + '<div class="actions small"><button type="button" class="btn quiet" data-growth-habit="' + esc(habit.id) + '" data-title="' + esc(habit.phrase) + '">Retire</button></div>'
            + '</div>';
        }).join("") : '<div class="empty">No habits yet.</div>')
        + (data.retiredHabits.length ? '<div class="line">Dropped: ' + data.retiredHabits.map(function (habit) { return '"' + esc(habit.phrase) + '"'; }).join(", ") + '</div>' : '')
        + '<div class="sub">Recent nights</div>'
        + (data.passes.length ? data.passes.map(function (pass) {
          return '<div class="item"><div class="head"><span class="route">' + esc(pass.outcome) + '</span>'
            + '<span class="meta">' + esc(rel(pass.ranAt)) + ' · ' + esc(pass.turns) + ' turns</span></div>'
            + '<div class="line">' + esc(pass.detail) + '</div></div>';
        }).join("") : '<div class="empty">No nights yet.</div>'));
    }

    growth.addEventListener("click", function (event) {
      var rollback = event.target.closest("[data-growth-rollback]");
      if (rollback && !rollback.disabled) {
        var version = Number(rollback.getAttribute("data-growth-rollback"));
        if (!window.confirm("Roll ${their} account back to version " + version + "? The newer versions stay in ${their} history.")) return;
        reviewAction(rollback, "self-model/action", { action: "growth_rollback", id: version });
        return;
      }
      var habit = event.target.closest("[data-growth-habit]");
      if (habit && !habit.disabled) {
        if (!window.confirm('Retire "' + habit.getAttribute("data-title") + '"?')) return;
        reviewAction(habit, "self-model/action", { action: "growth_retire_habit", id: Number(habit.getAttribute("data-growth-habit")) });
      }
    });

    tastes.addEventListener("click", function (event) {
      var opinion = event.target.closest("[data-opinion]");
      if (opinion && !opinion.disabled) {
        if (!window.confirm('Forget ${their} opinion on "' + opinion.getAttribute("data-title") + '"?')) return;
        reviewAction(opinion, "self-model/action", { action: "forget_opinion", opinionId: opinion.getAttribute("data-opinion") });
        return;
      }
      var taste = event.target.closest("[data-taste]");
      if (taste && !taste.disabled) {
        reviewAction(taste, "self-model/action", { preferenceId: taste.getAttribute("data-taste"), action: taste.getAttribute("data-action") });
      }
    });

    metrics.addEventListener("click", function (event) {
      var card = event.target.closest("[data-target]");
      if (card) focusPanel(card.getAttribute("data-target"));
    });

    /* A personality tail arrives after the reply: poll /voice/tail/<id> for up to 12.5 s. */
    function tailUrl(path) {
      return String(path || "").replace(/^[/]+/, "");
    }

    function cancelTail(path) {
      if (tailUrl(path)) fetch(tailUrl(path), { method: "DELETE" }).catch(function () {});
    }

    function retireActiveTail() {
      tailGeneration += 1;
      if (activeTailPath) cancelTail(activeTailPath);
      activeTailPath = null;
    }

    async function pollTail(tail) {
      var path = tail && tail.poll_path;
      if (!tailUrl(path)) return;
      if (activeTailPath && activeTailPath !== path) cancelTail(activeTailPath);
      activeTailPath = path;
      var generation = ++tailGeneration;
      for (var deadline = Date.now() + 12500; Date.now() < deadline;) {
        await new Promise(function (resolve) { setTimeout(resolve, 250); });
        if (generation !== tailGeneration || activeTailPath !== path) return cancelTail(path);
        var result;
        try {
          var response = await fetch(tailUrl(path));
          result = response.ok ? (await response.json()).tail : { status: "gone" };
        } catch (error) {
          result = { status: "gone" };
        }
        if (!result || result.status === "pending") continue;
        if (result.status === "ready" && result.text && generation === tailGeneration) {
          messagesState.push({ role: "${name}", text: result.text });
          renderMessages();
        }
        if (activeTailPath === path) activeTailPath = null;
        return;
      }
      if (generation === tailGeneration && activeTailPath === path) {
        cancelTail(path);
        activeTailPath = null;
      }
    }

    async function submitMessage() {
      var text = draft.value.trim();
      if (!text || send.disabled) return;
      retireActiveTail();
      messagesState.push({ role: "You", text: text });
      renderMessages();
      draft.value = "";
      send.disabled = true;
      try {
        var body = await postJson("chat", {
          utterance: text,
          room: "dashboard",
          channel: "chat",
          source_via: "jarvis_dashboard_ui",
          session_id: chatSessionId,
          conversation_mode: true,
          speaker_name: ${JSON.stringify(householdOwner()?.name ?? "")},
          voice_id: ${JSON.stringify(householdOwnerId() ?? "")},
          speaker_confidence: 1
        });
        messagesState.push({
          role: "${name}",
          text: body.response || body.text || "",
          meta: [body.route && body.route.route, body.route && body.route.status].filter(Boolean).join(" · ")
        });
        renderMessages();
        pollTail(body.speech && body.speech.tail);
        loadDashboard();
      } catch (error) {
        setStatus("error", false);
        showError(error);
      } finally {
        send.disabled = false;
      }
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitMessage();
    });
    draft.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitMessage();
      }
    });

    /* Settings */
    function shown(value) {
      if (value === true) return "on";
      if (value === false) return "off";
      return EFFORT_LABELS[value] || String(value);
    }

    function control(row) {
      var disabled = busy[row.key] || row.unavailable ? " disabled" : "";
      if (row.kind === "boolean") {
        return '<button type="button" class="switch" role="switch" aria-checked="' + String(row.value === true) + '"'
          + ' aria-label="' + esc(row.label) + '" data-setting="' + esc(row.key) + '"' + disabled + '></button>';
      }
      var values = row.values.filter(function (value) { return value !== "default" || row.value === "default"; });
      return '<div class="seg" role="radiogroup" aria-label="' + esc(row.label) + '">' + values.map(function (value) {
        return '<button type="button" role="radio" aria-checked="' + String(row.value === value) + '"'
          + ' data-setting="' + esc(row.key) + '" data-value="' + esc(value) + '"' + disabled + '>' + esc(EFFORT_LABELS[value] || value) + '</button>';
      }).join("") + '</div>';
    }

    function settingRow(row) {
      var waiting = row.waitingOn && row.waitingOn.length ? row.waitingOn : [];
      var note = rowNotes[row.key];
      var foot = [];
      if (row.unavailable) foot.push('<span class="waiting-note">' + esc(row.unavailable) + '</span>');
      else if (waiting.length) foot.push('<span class="waiting-note">Needs ' + esc(waiting.join(" and ")) + ' on</span>');
      if (row.saved) {
        foot.push('<span>Add-on default: ' + esc(shown(row.defaultValue)) + '</span>'
          + '<button type="button" class="link" data-reset="' + esc(row.key) + '">Use default</button>');
      }
      if (note) foot.push('<span class="' + (note.ok ? "saved" : "failed") + '">' + esc(note.text) + '</span>');
      return '<div class="row' + (waiting.length || row.unavailable ? " waiting" : "") + '">'
        + '<div><div class="row-name">' + esc(row.label) + '</div><div class="row-help">' + esc(row.help) + '</div></div>'
        + control(row)
        + '<div class="row-foot">' + foot.join("") + '</div>'
        + '</div>';
    }

    function helperNote(key) {
      var note = rowNotes["helper:" + key];
      return note ? '<span class="' + (note.ok ? "saved" : "failed") + '">' + esc(note.text) + '</span>' : "";
    }

    function renderHelpers(helpers) {
      var off = !helpers.available || busy["helper:proactive"] ? " disabled" : "";
      var timesOff = !helpers.available ? " disabled" : "";
      helpersBox.innerHTML = '<div class="row">'
        + '<div><div class="row-name">Speak up unprompted</div><div class="row-help">Lets ${name} start a conversation when something matters.</div></div>'
        + '<button type="button" class="switch" role="switch" aria-checked="' + String(helpers.proactive === true) + '" aria-label="Speak up unprompted" data-helper="proactive"' + off + '></button>'
        + '<div class="row-foot">' + (helpers.available ? "" : '<span class="waiting-note">Home Assistant not connected</span>') + helperNote("proactive") + '</div>'
        + '</div>'
        + '<div class="row">'
        + '<div><div class="row-name">Quiet hours</div><div class="row-help">No speaking up between these times.</div></div>'
        + '<div class="times"><input type="time" aria-label="Quiet from" data-helper="silentFrom" value="' + esc(helpers.silentFrom || "") + '"' + timesOff + '>'
        + '<span>to</span>'
        + '<input type="time" aria-label="Quiet until" data-helper="silentUntil" value="' + esc(helpers.silentUntil || "") + '"' + timesOff + '></div>'
        + '<div class="row-foot">' + helperNote("silentFrom") + helperNote("silentUntil") + '</div>'
        + '</div>';
    }

    function renderSettings() {
      var body = settingsState;
      if (!body) return;
      ["talking", "memory", "quiet", "house"].forEach(function (group) {
        var box = document.querySelector('[data-group="' + group + '"]');
        var rows = body.rows.filter(function (row) { return row.group === group; });
        var html = rows.map(settingRow).join("");
        if (group === "memory") {
          html += '<div class="row"><div><div class="row-name">Memory alerts go to</div>'
            + '<div class="row-help">Set in code; no other phone is allowed.</div></div>'
            + '<span class="lock">' + esc(body.memoryAlerts.label) + '</span><div class="row-foot"></div></div>';
        }
        box.className = "";
        box.innerHTML = html;
      });
      renderHelpers(body.helpers);
    }

    // Sign the brain in with the house's own account (the vendor's own flow).
    var signInTimer = null;
    function renderSignIn(body) {
      var box = document.getElementById("signin-body");
      if (!box) return;
      var html;
      if (body.backend === "off") {
        html = '<div class="live-note">The AI is off, so house questions are still answered, just without it. Pick Claude or Codex in System, Settings to chat about anything.</div>';
      } else if (body.signedIn) {
        html = '<div class="live-note">Signed in to ' + (body.backend === "codex" ? "Codex" : "Claude") + ' with the house&#39;s own account.</div>';
      } else if (body.backend === "claude") {
        html = '<div class="live-note">Not signed in. On any computer with Claude Code, run <code>claude setup-token</code> with your own Claude account and paste it into <b>Claude sign-in token</b> in System, Settings, or set your own Anthropic API key there.</div>';
      } else {
        var codex = body.codex || { state: "idle" };
        if (codex.state === "waiting" && codex.url) {
          html = '<div class="live-note">' + esc(codex.message || "") + '</div>'
            + '<div class="row-name"><a href="' + esc(codex.url) + '" target="_blank" rel="noopener">' + esc(codex.url) + '</a></div>'
            + (codex.code ? '<div class="row-name">Code: <b>' + esc(codex.code) + '</b></div>' : "");
        } else {
          html = '<div class="live-note">' + esc(codex.state === "failed" ? codex.message : "Not signed in to Codex yet.") + '</div>'
            + '<button type="button" class="btn" id="signin-codex">Sign in with your OpenAI account</button>';
        }
      }
      box.className = "";
      box.innerHTML = html;
      var button = document.getElementById("signin-codex");
      if (button) button.addEventListener("click", async function () {
        button.disabled = true;
        try { renderSignIn(await postJson("signin", {})); pollSignIn(); } catch (error) { showError(error); button.disabled = false; }
      });
    }
    async function loadSignIn() {
      try {
        var response = await fetch("signin");
        var body = await response.json();
        if (response.ok && body.ok !== false) renderSignIn(body);
        return body;
      } catch (error) {
        return null;
      }
    }
    function pollSignIn() {
      if (signInTimer) window.clearTimeout(signInTimer);
      signInTimer = window.setTimeout(async function () {
        var body = await loadSignIn();
        if (body && body.codex && body.codex.state === "waiting") pollSignIn();
      }, 3000);
    }

    async function loadSettings() {
      void loadSignIn();
      try {
        var response = await fetch("settings");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "settings failed");
        settingsState = body;
        renderSettings();
      } catch (error) {
        showError(error);
      }
    }

    function flashNote(key, ok, text) {
      rowNotes[key] = { ok: ok, text: text };
      window.setTimeout(function () {
        if (rowNotes[key] && rowNotes[key].text === text) {
          delete rowNotes[key];
          renderSettings();
        }
      }, ok ? 1800 : 6000);
    }

    async function saveSetting(key, payload) {
      if (busy[key]) return;
      busy[key] = true;
      var previous = settingsState;
      // Optimistic: the control moves at once; a failed save puts it back.
      if (payload.reset !== true) {
        settingsState = Object.assign({}, previous, {
          rows: previous.rows.map(function (row) { return row.key === key ? Object.assign({}, row, { value: payload.value }) : row; })
        });
      }
      renderSettings();
      try {
        settingsState = await postJson("settings", Object.assign({ key: key }, payload));
        errorBox.textContent = "";
        flashNote(key, true, "Saved");
      } catch (error) {
        settingsState = previous;
        flashNote(key, false, "Not saved: " + (error instanceof Error ? error.message : String(error)));
      } finally {
        busy[key] = false;
        renderSettings();
      }
    }

    async function saveHelper(helper, value) {
      var key = "helper:" + helper;
      if (busy[key]) return;
      busy[key] = true;
      var previous = settingsState;
      var next = Object.assign({}, previous.helpers);
      next[helper] = value;
      settingsState = Object.assign({}, previous, { helpers: next });
      renderSettings();
      try {
        settingsState = await postJson("settings/helper", { helper: helper, value: value });
        errorBox.textContent = "";
        flashNote(key, true, "Saved");
      } catch (error) {
        settingsState = previous;
        flashNote(key, false, "Not saved: " + (error instanceof Error ? error.message : String(error)));
      } finally {
        busy[key] = false;
        renderSettings();
      }
    }

    document.querySelector(".main").addEventListener("click", function (event) {
      var reset = event.target.closest("[data-reset]");
      if (reset) {
        saveSetting(reset.getAttribute("data-reset"), { reset: true });
        return;
      }
      var helper = event.target.closest('button[data-helper]');
      if (helper && !helper.disabled) {
        saveHelper(helper.getAttribute("data-helper"), helper.getAttribute("aria-checked") !== "true");
        return;
      }
      var button = event.target.closest("[data-setting]");
      if (!button || button.disabled) return;
      var key = button.getAttribute("data-setting");
      if (button.hasAttribute("data-value")) {
        if (button.getAttribute("aria-checked") === "true") return;
        saveSetting(key, { value: button.getAttribute("data-value") });
      } else {
        saveSetting(key, { value: button.getAttribute("aria-checked") !== "true" });
      }
    });

    document.querySelector(".main").addEventListener("change", function (event) {
      var input = event.target.closest('input[data-helper]');
      if (input && input.value) saveHelper(input.getAttribute("data-helper"), input.value);
    });

    /* Names */
    var namesBox = document.getElementById("names");
    var nameFormSlot = document.getElementById("name-form-slot");
    var entityList = document.getElementById("entity-list");
    var namesState = null;
    var nameEditing = null;
    var nameConfirm = null;
    var nameBusy = false;
    var nameNote = null;
    var entityCount = -1;

    function targetText(targets) {
      return targets.map(function (target) {
        var label = esc(target.name || target.entityId);
        return target.missing ? '<span class="missing">' + label + ' (not in Home Assistant)</span>' : label;
      }).join(", ");
    }

    function renderNames() {
      var body = namesState;
      if (!body) return;
      var roster = document.getElementById("roster");
      if (roster) { roster.className = "roster"; roster.textContent = body.roster.text; }
      if (entityCount !== body.entities.length) {
        entityCount = body.entities.length;
        entityList.innerHTML = body.entities.map(function (entity) {
          return '<option value="' + esc(entity.id) + '">' + esc(entity.name || "") + '</option>';
        }).join("");
      }
      var rows = body.names.map(function (row) {
        var actions;
        if (row.locked) actions = '<span class="lock">Locked</span>';
        else if (nameConfirm === row.alias) {
          actions = '<div class="name-actions"><button type="button" class="btn" data-name-remove="' + esc(row.alias) + '"' + (nameBusy ? " disabled" : "") + '>Remove</button>'
            + '<button type="button" class="btn quiet" data-name-keep>Keep</button></div>';
        } else {
          actions = '<div class="name-actions"><button type="button" class="btn quiet" data-name-edit="' + esc(row.alias) + '">Edit</button>'
            + '<button type="button" class="btn quiet" data-name-ask="' + esc(row.alias) + '">Remove</button></div>';
        }
        var foot = [];
        if (row.notes) foot.push('<span>' + esc(row.notes) + '</span>');
        if (row.locked) foot.push('<span>Locked: ' + esc(row.locked) + '</span>');
        if (nameNote && nameNote.alias === row.alias) foot.push('<span class="' + (nameNote.ok ? "saved" : "failed") + '">' + esc(nameNote.text) + '</span>');
        return '<div class="row name-row">'
          + '<div><div class="row-name">' + esc(row.alias) + '</div><div class="row-help">' + targetText(row.targets) + '</div></div>'
          + actions
          + '<div class="row-foot">' + foot.join("") + '</div>'
          + '</div>';
      });
      namesBox.className = rows.length ? "" : "empty";
      namesBox.innerHTML = rows.length ? rows.join("") : "No names yet.";
    }

    function renderVoiceList(voice) {
      var box = document.getElementById("voice-list");
      if (!voice.loaded) {
        box.className = "empty";
        box.textContent = voice.error ? "The voice list didn't load: " + voice.error : "Not read from Home Assistant yet.";
        return;
      }
      var rows = voice.devices.map(function (device) {
        return '<div class="row"><div><div class="row-name">' + targetText([device]) + '</div>'
          + '<div class="row-help">' + esc(device.aliases.length ? device.aliases.join(", ") : "No alias") + '</div></div></div>';
      });
      if (voice.clashes.length) rows.push('<div class="row-foot"><span class="failed">Shared by two devices, so not used: ' + esc(voice.clashes.join(", ")) + '</span></div>');
      if (voice.error) rows.push('<div class="row-foot"><span class="failed">Last read failed: ' + esc(voice.error) + '</span></div>');
      box.className = voice.devices.length ? "" : "empty";
      box.innerHTML = voice.devices.length ? rows.join("") : "Nothing is exposed to Assist.";
    }

    function deviceInput(value) {
      return '<div class="device"><input type="text" list="entity-list" aria-label="Device" placeholder="Start typing a device" value="' + esc(value) + '" autocomplete="off" spellcheck="false">'
        + '<button type="button" class="btn quiet" data-device-drop aria-label="Remove this device">&times;</button></div>';
    }

    function openNameForm(row) {
      nameEditing = row ? row.alias : "";
      nameConfirm = null;
      var ids = row ? row.targets.map(function (target) { return target.entityId; }) : [""];
      nameFormSlot.innerHTML = '<form class="name-form" id="name-form">'
        + '<label>Name<input type="text" id="name-alias" maxlength="60" placeholder="${exampleHouseholdName()}&#39;s computer" value="' + esc(row ? row.alias : "") + '" autocomplete="off"></label>'
        + '<label>Device<div class="devices" id="name-devices">' + ids.map(deviceInput).join("") + '</div></label>'
        + '<div><button type="button" class="link" id="name-more">Add another device</button></div>'
        + '<label>Note (optional)<input type="text" id="name-notes" maxlength="200" value="' + esc(row && row.notes ? row.notes : "") + '" autocomplete="off"></label>'
        + '<div class="actions" style="margin-top: 0"><button type="submit" class="btn" id="name-save">Save</button><button type="button" class="btn quiet" id="name-cancel">Cancel</button></div>'
        + '<div class="failed" id="name-error" role="alert"></div>'
        + '</form>';
      document.getElementById("name-alias").focus();
      renderNames();
    }

    function closeNameForm() {
      nameEditing = null;
      nameFormSlot.innerHTML = "";
    }

    /* House: everything in use, from Home Assistant or set up by hand; each block saves itself */
    var houseBox = document.getElementById("house-found-rows");
    var houseBody = null;
    var houseDraft = null;
    var HOUSE_BLOCKS = { speakers: ["speakers"], power: ["power"], solarPower: ["solarPower"], houseEnergy: ["houseEnergy"], devices: ["devices"], budget: ["budgetKwh"], leftOpen: ["leftOpen"], vacuum: ["vacuum"], weather: ["weather", "outsideTemperature", "outsideWind"], calendars: ["calendars"] };
    var HAND_PART = { power: "power", solarPower: "power", houseEnergy: "power", devices: "power", budget: "budget", leftOpen: "leftOpen", vacuum: "vacuum", weather: "weather", calendars: "calendars" };

    function houseCopy(value) { return JSON.parse(JSON.stringify(value)); }

    function blockDirty(block) {
      return HOUSE_BLOCKS[block].some(function (key) { return JSON.stringify(houseDraft[key]) !== JSON.stringify(houseBody.page[key]); });
    }

    function showBlockSave(block) {
      var bar = houseBox.querySelector('[data-block-save="' + block + '"]');
      if (bar) bar.hidden = !blockDirty(block);
    }

    function houseOptions(options, current, none) {
      return '<option value=""' + (current ? "" : " selected") + '>' + esc(none) + '</option>'
        + options.map(function (option) {
          return '<option value="' + esc(option.id) + '"' + (option.id === current ? " selected" : "") + '>'
            + esc(option.name) + (option.value ? " · " + esc(option.value) : "") + '</option>';
        }).join("");
    }

    function houseSelect(key, options, current, none, label) {
      return '<select class="pick" data-house="' + key + '" aria-label="' + esc(label) + '">' + houseOptions(options, current, none) + '</select>';
    }

    function houseChecks(key, options, chosen) {
      if (!options.length) return '<div class="row-help">None in Home Assistant.</div>';
      return '<div class="checklist">' + options.map(function (option) {
        return '<label><input type="checkbox" data-house-list="' + key + '" value="' + esc(option.id) + '"'
          + (chosen.indexOf(option.id) >= 0 ? " checked" : "") + '> ' + esc(option.name) + '</label>';
      }).join("") + '</div>';
    }

    function houseBlock(block, title, help, control) {
      var hand = block && houseBody.handMade[HAND_PART[block]] ? ' <span class="meta">set up by hand</span>' : "";
      return '<div class="house-block"><div class="house-head"><div class="row-name">' + esc(title) + hand + '</div>'
        + '<div class="row-help">' + esc(help) + '</div></div>' + control
        + (block ? '<div class="actions block-save" data-block-save="' + block + '"' + (blockDirty(block) ? "" : " hidden") + '>'
          + '<button type="button" class="btn" data-save-block="' + block + '">Save</button></div>' : "")
        + '</div>';
    }

    function renderHouse() {
      var body = houseBody, draft = houseDraft, o = body.options;
      var devices = body.devices.length ? body.devices.map(function (device) {
        var own = draft.devices[device.id] || { power: null, names: [] };
        return '<div class="device-row"><div class="row-name">' + esc(device.label) + '</div>'
          + '<select class="pick" data-device-power="' + esc(device.id) + '" aria-label="' + esc(device.label) + ' power sensor">' + houseOptions(o.power, own.power, "No power sensor") + '</select>'
          + '<input type="text" data-device-names="' + esc(device.id) + '" value="' + esc(own.names.join(", ")) + '" placeholder="Also called (optional)" aria-label="Other names for ' + esc(device.label) + '"></div>';
      }).join("") : '<div class="row-help">None yet. Add them in Home Assistant: Settings, Dashboards, Energy.</div>';
      var speakers = body.speakers.length ? body.speakers.map(function (speaker) {
        return '<div class="device-row speaker-row"><div class="row-name">' + esc(speaker.label) + '</div>'
          + '<select class="pick" data-speaker="' + esc(speaker.id) + '" aria-label="' + esc(speaker.label) + ' music player">' + houseOptions(o.musicPlayers, draft.speakers[speaker.id] || null, "No music") + '</select></div>';
      }).join("") : '<div class="row-help">No voice speakers in Home Assistant yet.</div>';
      houseBox.className = "";
      houseBox.innerHTML = [
        houseBlock("speakers", "Speakers", "Where music plays when you ask a speaker for it (a Music Assistant player).",
          o.musicPlayers.length || !body.speakers.length ? speakers : speakers + '<div class="row-help">Music needs Music Assistant in Home Assistant.</div>'),
        houseBlock("power", "Whole-house power", "What ${name} reads when you ask how much power the house is using.",
          houseSelect("power", o.power, draft.power, "None", "Whole-house power")),
        houseBlock("solarPower", "Solar power now", "What ${name} reads for how much the panels are making.",
          houseSelect("solarPower", o.power, draft.solarPower, "None", "Solar power now")),
        houseBlock("houseEnergy", "Whole-house energy", "What ${name} reads when you ask how much the house used today.",
          houseSelect("houseEnergy", o.energy, draft.houseEnergy, "Worked out from the meters", "Whole-house energy")),
        houseBlock("devices", "Devices", "From the Energy dashboard. Each one's live power, and other names you call it.", devices),
        houseBlock("budget", "Monthly electricity budget", "${name} tells you how the month is tracking against it. Leave empty for none.",
          '<input type="number" class="budget" min="1" step="1" inputmode="numeric" data-house-number="budgetKwh" value="' + (draft.budgetKwh === null ? "" : esc(String(draft.budgetKwh))) + '" placeholder="kWh a month" aria-label="Monthly electricity budget in kWh">'),
        houseBlock("leftOpen", "Doors and locks to watch", "${name} mentions these when they're left open or unlocked.",
          houseChecks("leftOpen", o.openings, draft.leftOpen)),
        houseBlock("vacuum", "Robot vacuum", "The one ${name} starts, pauses and sends home when you ask.",
          houseSelect("vacuum", o.vacuums, draft.vacuum, "None", "Robot vacuum")),
        houseBlock("weather", "Weather", "Forecasts come from the weather entity; the outside sensors give what it's like right now.",
          '<div class="weather-picks">'
            + '<label class="field"><span>Forecast</span>' + houseSelect("weather", o.weathers, draft.weather, "None", "Weather forecast") + '</label>'
            + '<label class="field"><span>Outside temperature</span>' + houseSelect("outsideTemperature", o.temperatures, draft.outsideTemperature, "From the forecast", "Outside temperature") + '</label>'
            + '<label class="field"><span>Outside wind</span>' + houseSelect("outsideWind", o.winds, draft.outsideWind, "From the forecast", "Outside wind") + '</label>'
          + '</div>'),
        houseBlock("calendars", "Calendars", "What ${name} reads for what's on.",
          houseChecks("calendars", o.calendars, draft.calendars)),
        houseBlock(null, "Who lives here", body.people.length ? body.people.join(", ") + "." : "Nobody linked yet.",
          '<button type="button" class="btn quiet" data-view-jump="people">Link people on the People page</button>')
      ].join("") + (body.discoveredAt ? '<div class="meta house-when">Last looked ' + esc(new Date(body.discoveredAt).toLocaleString()) + '</div>' : "");
    }

    /* A fresh body from the server; unsaved changes in other blocks stay as they were. */
    function useHouse(body, savedBlock) {
      var draft = houseDraft;
      houseBody = body;
      houseDraft = houseCopy(body.page);
      if (draft) Object.keys(HOUSE_BLOCKS).forEach(function (block) {
        if (block === savedBlock) return;
        HOUSE_BLOCKS[block].forEach(function (key) {
          if (JSON.stringify(draft[key]) !== JSON.stringify(body.page[key])) houseDraft[key] = draft[key];
        });
      });
      renderHouse();
    }

    async function loadDiscovery() {
      try {
        var response = await fetch("house/discovery");
        var body = await response.json().catch(function () { return {}; });
        if (!response.ok || body.ok === false) throw new Error(response.status === 503 ? "Needs Home Assistant to be connected." : (body.error || "discovery failed"));
        useHouse(body);
      } catch (error) {
        houseBox.className = "empty";
        houseBox.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function houseNames(value) {
      return value.split(",").map(function (name) { return name.trim(); }).filter(Boolean);
    }

    function deviceDraft(id, change) {
      houseDraft.devices[id] = Object.assign({ power: null, names: [] }, houseDraft.devices[id], change);
    }

    houseBox.addEventListener("change", function (event) {
      var target = event.target;
      if (target.hasAttribute("data-house")) {
        var key = target.getAttribute("data-house");
        houseDraft[key] = target.value || null;
        showBlockSave(Object.keys(HOUSE_BLOCKS).filter(function (block) { return HOUSE_BLOCKS[block].indexOf(key) >= 0; })[0]);
      } else if (target.hasAttribute("data-house-list")) {
        var key = target.getAttribute("data-house-list");
        var chosen = houseDraft[key].filter(function (id) { return id !== target.value; });
        if (target.checked) chosen.push(target.value);
        houseDraft[key] = chosen;
        showBlockSave(key);
      } else if (target.hasAttribute("data-speaker")) {
        houseDraft.speakers = Object.assign({}, houseDraft.speakers);
        houseDraft.speakers[target.getAttribute("data-speaker")] = target.value || null;
        showBlockSave("speakers");
      } else if (target.hasAttribute("data-device-power")) {
        deviceDraft(target.getAttribute("data-device-power"), { power: target.value || null });
        showBlockSave("devices");
      }
    });

    houseBox.addEventListener("input", function (event) {
      if (event.target.hasAttribute("data-house-number")) {
        var amount = event.target.value.trim();
        houseDraft.budgetKwh = amount === "" ? null : Math.round(Number(amount));
        showBlockSave("budget");
        return;
      }
      var id = event.target.getAttribute("data-device-names");
      if (!id) return;
      deviceDraft(id, { names: houseNames(event.target.value) });
      showBlockSave("devices");
    });

    houseBox.addEventListener("click", async function (event) {
      var jump = event.target.closest("[data-view-jump]");
      var save = event.target.closest("[data-save-block]");
      if (jump) { showView(jump.getAttribute("data-view-jump")); return; }
      if (!save) return;
      var block = save.getAttribute("data-save-block");
      if (block === "vacuum" && houseBody.vacuumRooms && !window.confirm("This vacuum is set up to clean room by room. Changing it here means it can only be started, paused and sent home. Change it?")) return;
      var wanted = houseCopy(houseBody.page);
      HOUSE_BLOCKS[block].forEach(function (key) { wanted[key] = houseDraft[key]; });
      save.disabled = true;
      try {
        useHouse(await postJson("house/choices", wanted), block);
      } catch (error) {
        save.disabled = false;
        showError(error);
      }
    });

    document.getElementById("house-look").addEventListener("click", async function () {
      var button = this;
      button.disabled = true;
      try { useHouse(await postJson("house/discovery", {})); } catch (error) { showError(error); }
      button.disabled = false;
    });

    async function loadNames() {
      try {
        var response = await fetch("settings/names");
        var body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(body.error || "names failed");
        namesState = body;
        renderNames();
        renderVoiceList(body.voice);
      } catch (error) {
        namesBox.className = "empty";
        namesBox.textContent = "Names didn't load: " + (error instanceof Error ? error.message : String(error));
      }
    }

    function flashName(alias, ok, text) {
      nameNote = { alias: alias, ok: ok, text: text };
      window.setTimeout(function () {
        if (nameNote && nameNote.text === text) { nameNote = null; renderNames(); }
      }, ok ? 1800 : 6000);
    }

    async function saveName() {
      if (nameBusy) return;
      var errorLine = document.getElementById("name-error");
      var payload = {
        action: "save",
        alias: document.getElementById("name-alias").value,
        entityIds: Array.prototype.map.call(document.querySelectorAll("#name-devices input"), function (input) { return input.value; })
          .filter(function (value) { return value.trim(); }),
        notes: document.getElementById("name-notes").value
      };
      if (nameEditing) payload.previousAlias = nameEditing;
      nameBusy = true;
      document.getElementById("name-save").disabled = true;
      try {
        namesState = await postJson("settings/names", payload);
        var saved = payload.alias.trim().split(" ").filter(Boolean).join(" ");
        closeNameForm();
        flashName(saved, true, "Saved");
      } catch (error) {
        errorLine.textContent = "Not saved: " + (error instanceof Error ? error.message : String(error));
        document.getElementById("name-save").disabled = false;
      } finally {
        nameBusy = false;
        renderNames();
      }
    }

    async function removeName(alias) {
      if (nameBusy) return;
      nameBusy = true;
      renderNames();
      try {
        namesState = await postJson("settings/names", { action: "remove", alias: alias });
        nameConfirm = null;
        if (nameEditing === alias) closeNameForm();
      } catch (error) {
        nameConfirm = null;
        flashName(alias, false, "Not removed: " + (error instanceof Error ? error.message : String(error)));
      } finally {
        nameBusy = false;
        renderNames();
      }
    }

    function findNameRow(alias) {
      return (namesState ? namesState.names : []).filter(function (row) { return row.alias === alias; })[0] || null;
    }

    document.getElementById("name-add").addEventListener("click", function () { openNameForm(null); });
    nameFormSlot.addEventListener("click", function (event) {
      if (event.target.closest("#name-cancel")) { closeNameForm(); return; }
      if (event.target.closest("#name-more")) {
        var devices = document.getElementById("name-devices");
        devices.insertAdjacentHTML("beforeend", deviceInput(""));
        devices.lastElementChild.querySelector("input").focus();
        return;
      }
      var drop = event.target.closest("[data-device-drop]");
      if (drop) {
        var all = document.querySelectorAll("#name-devices .device");
        if (all.length > 1) drop.closest(".device").remove();
        else drop.closest(".device").querySelector("input").value = "";
      }
    });
    nameFormSlot.addEventListener("submit", function (event) {
      event.preventDefault();
      saveName();
    });
    namesBox.addEventListener("click", function (event) {
      var edit = event.target.closest("[data-name-edit]");
      if (edit) { openNameForm(findNameRow(edit.getAttribute("data-name-edit"))); return; }
      var ask = event.target.closest("[data-name-ask]");
      if (ask) { nameConfirm = ask.getAttribute("data-name-ask"); renderNames(); return; }
      if (event.target.closest("[data-name-keep]")) { nameConfirm = null; renderNames(); return; }
      var remove = event.target.closest("[data-name-remove]");
      if (remove && !remove.disabled) removeName(remove.getAttribute("data-name-remove"));
    });

    // Deep link: "#settings" here. Home Assistant always opens the ingress root,
    // then tells a subscribed page the rest of its route (buzz):
    // "/<panel>/dashboard-ui/settings" (the house's nav Settings) opens Settings (knob).
    showView((window.location.hash || "").replace("#", ""), false);
    if (window.parent !== window) {
      var lastRoute = null;
      window.addEventListener("message", function (event) {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        var data = event.data || {};
        if (data.type !== "home-assistant/properties") return;
        var route = typeof data.route === "string"
          ? data.route
          : data.route ? (data.route.prefix || "") + "/" + (data.route.path || "") : "";
        if (route === lastRoute) return;
        lastRoute = route;
        var parts = route.split("/");
        var at = parts.indexOf("dashboard-ui");
        if (at >= 0 && parts[at + 1]) showView(parts[at + 1]);
      });
      window.parent.postMessage({ type: "home-assistant/subscribe-properties" }, window.location.origin);
    }
    renderMessages();
    loadDashboard();
    setInterval(loadDashboard, 5000);
  </script>
</body>
</html>`;
}
