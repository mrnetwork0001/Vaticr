# Vaticr demo video

A Remotion composition mixing motion graphics with recorded footage of the live
app, narrated through ElevenLabs. Nothing in it is mocked: the footage is
usevaticr.xyz on Somnia testnet, and every figure in the graphics is one the
repository can back.

```bash
npm install
npm run capture     # records public/footage/*.webm from the live site
#   then transcode:  ffmpeg -i landing.webm -c:v libx264 -crf 18 -pix_fmt yuv420p -an landing.mp4
npm run narrate     # ElevenLabs voice-over, cached - re-runs never spend again
npm run manifest    # public/manifest.json: real durations + capture event times
npm run stills      # one PNG per beat, to eyeball before committing to a render
npm run render      # out/vaticr-demo.mp4, 1920x1080, 30fps
```

## The cut

Ten beats, alternating graphics and footage, in `src/timeline.ts`. Durations
are derived rather than chosen: a beat lasts as long as its narration plus a
tail, and a footage beat never ends before the footage it needs.

| Beat | Kind | What it carries |
|---|---|---|
| intro | graphic | Mark, wordmark, tagline |
| claim | footage | The landing hero: an event contract is a probability |
| gap | graphic | Model 0.899 against book 0.889, and the distance between |
| how | footage | Prior from the price process, posterior from scored news |
| **trade** | **footage** | **Hand-recorded wallet flow - see below** |
| mint | graphic | The crossing matrix, and two bids summing to 1 − 2δ |
| bot | footage | Live windows priced against the top of each book |
| evidence | graphic | Reliability diagram, Brier 0.15522, skill +0.3791 |
| proof | footage | Settlement audit, 10 of 10 verified |
| close | graphic | Four defensible numbers, and where to find the rest |

## The one clip that is not scripted

`trade` needs a real signer and a real approval prompt, and a headless browser
can produce neither. Record it by hand at 1920x1080, drop it at
`public/footage/trade.mp4`, and re-run `manifest` and `render` - the timeline
picks it up automatically and falls back to dashboard footage until it exists.

Wanted in that take: the onboarding panel on a wallet with nothing in it, the
mint confirmation, the ticket showing model against book, and the fill.

## Sources of truth

- Narration: `narration/script.json`, mirrored in `../docs/VIDEO_SCRIPT.md`
- Palette: `src/theme.ts`, lifted from the app's `tailwind.config.ts` - indigo
  is what the model says, amber is what the book asks, and every graphic here
  obeys that pairing
- Evidence figures: `../docs/evidence/backtest-2026-09-04.json`
