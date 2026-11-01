# transfer

Peer-to-peer file transfer in the browser. The sender picks files and gets a
four-digit code; the receiver opens the link or enters the code, and the
files stream directly between the two browsers over WebRTC. Nothing is
uploaded or stored.

Static site, no build step, no backend.

## Run locally

```sh
python3 -m http.server 8000 -d public
```

Open two tabs (or two devices on the same network) at http://localhost:8000.

## Deploy

Netlify picks up `netlify.toml`, which publishes `public/` and sets security
headers. Either connect the repo in the Netlify dashboard or run:

```sh
npx netlify-cli deploy --prod
```

## How it works

- **Signaling:** the [PeerJS](https://peerjs.com) public server (`0.peerjs.com`)
  introduces the two browsers. The sender registers as `transfer-<CODE>`.
- **Relay:** PeerJS's bundled TURN servers are used when a direct connection
  isn't possible. To use your own, pass `config: { iceServers: [...] }` to
  `new Peer()` in `public/app.js`.
- **Transfer:** files are sent in 64 KB chunks over an ordered, reliable data
  channel, with backpressure so large files aren't read into memory at once.

## Limits

- The sender's tab must stay open until the receiver has everything.
- Received files are assembled in the browser before saving. Chrome and Edge
  handle multi-gigabyte files; Safari and Firefox may run out of memory on very
  large ones.
- Anyone with the code can receive the files while the sender's tab is open.
  Codes are four random digits (10,000 combinations) and die when the tab
  closes. Anyone who guesses an active code can receive its files.
