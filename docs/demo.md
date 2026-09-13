# Reproducing the README screenshot

The screenshot uses the real Notes UI and the fictional content in
[`demo-board.json`](demo-board.json). Its landscape illustration is original
project artwork covered by the repository's MIT license. No user data or external
photographs are included.

Create a disposable database in a fresh temporary directory:

```sh
npm ci
npm run build
demo_dir=$(mktemp -d)
node --import tsx scripts/seed-demo.ts "$demo_dir"
DATABASE_PATH="$demo_dir/notes.sqlite" IMAGES_PATH="$demo_dir/images" \
  ORIGIN=http://localhost:5181 RP_ID=localhost HOST=127.0.0.1 PORT=5181 \
  node --import tsx apps/server/src/index.ts
```

Open `http://localhost:5181`, choose **Sign in with a key**, and use the temporary
key saved in `$demo_dir/access-key.txt`. The script refuses to overwrite an
existing database. The seed account is local to this temporary server.

For the README image, use an English browser locale, the dark system theme, and a
1920 × 1080 viewport at device scale 1. Keep the pointer off the notes so hover
controls do not obscure the content. Capture the viewport, encode it as WebP,
and visually check that small text remains readable. The checked-in image is
[`assets/board.webp`](assets/board.webp).

Stop the demo server when finished. The temporary directory contains only the
disposable demo account, encrypted board data, and its access key; do not commit it.
