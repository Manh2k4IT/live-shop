# Live Shop

Ung dung quan ly san pham + gio hang realtime bang Node.js, Express va Socket.IO.

## Chay local

1. Cai dependency:

```bash
npm install
```

2. Tao file `.env` tu `.env.example` (neu can):

```bash
copy .env.example .env
```

3. Chay server:

```bash
npm start
```

Hoac chay bang PM2 (tu restart khi loi):

```bash
npm run start:pm2
```

Server mac dinh chay o `http://localhost:3000`.

## Luu tru ben vung

Server tu dong luu du lieu vao file JSON de khong mat sau khi restart:

- `DATA_DIR/state.json`: products, cart, orders, revision
- `UPLOAD_DIR`: hinh upload

Mac dinh:

- `DATA_DIR=./data`
- `UPLOAD_DIR=./uploads`

Co the doi bang bien moi truong khi deploy.

## Bien moi truong

- `PORT`: cong server (mac dinh `3000`)
- `DATA_DIR`: thu muc luu state JSON
- `UPLOAD_DIR`: thu muc luu upload image
- `PERSIST_DEBOUNCE_MS`: gom nhieu update trong N ms roi moi ghi file (mac dinh `200`)
- `BROADCAST_DEBOUNCE_MS`: gom nhieu update trong N ms roi moi phat socket update (mac dinh `100`)
- `REQUEST_JSON_LIMIT`: gioi han kich thuoc JSON body
- `COMPRESSION_THRESHOLD_BYTES`: bat nen response tu nguong byte nay
- `MAX_INFLIGHT_REQUESTS`: nguong request dang xu ly dong thoi (vuot nguong tra `503`)
- `WRITE_RATE_WINDOW_MS`, `WRITE_RATE_MAX`: gioi han tan suat endpoint ghi
- `CHECKOUT_RATE_WINDOW_MS`, `CHECKOUT_RATE_MAX`: gioi han tan suat checkout
- `UPLOAD_MAX_FILE_SIZE_MB`: gioi han kich thuoc file upload
- `KEEP_ALIVE_TIMEOUT_MS`, `HEADERS_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`: timeout HTTP server
- `SOCKET_PING_INTERVAL_MS`, `SOCKET_PING_TIMEOUT_MS`, `SOCKET_MAX_BUFFER_BYTES`: timeout/bo nho Socket.IO
- `CART_SESSION_COOKIE`: ten cookie de tach gio hang theo tung nguoi dung
- `CART_SESSION_MAX_AGE_MS`: thoi gian ton tai cookie gio hang

## On dinh khi dong nguoi

- Server da duoc toi uu de tranh nghen I/O:
   - Ghi `state.json` theo hang doi, khong ghi dong bo tren moi request.
   - Gom nhieu lan thay doi gan nhau truoc khi ghi file.
   - Socket update duoc throttle de tranh spam su kien khi admin thao tac nhanh.
   - Gioi han request ghi de chong burst/abuse.
   - Co co che shed load khi vuot nguong request dang xu ly.
   - Response duoc nen de giam bandwidth va CPU spike do payload lon.
   - Upload duoc gioi han dung luong de tranh ngop RAM/disk.
   - Shutdown an toan: flush state truoc khi process tat.
   - Gio hang da tach theo session cookie de tranh nguoi dung bi dung chung cart khi tai cao.

- Goi y khi tai cao (vai tram user cung luc):
   - Tang server instance (neu platform cho scale).
   - Dat `DATA_DIR` + `UPLOAD_DIR` tren disk ben vung (SSD).
   - Bat sticky session neu scale nhieu instance va van dung in-memory cart.
   - Neu scale nhieu instance, nen chuyen cart/session sang Redis hoac DB dung chung de dong bo.
   - Dat alert theo `/health` (uptime, memory, inflight requests) de phat hien qua tai som.

Luu y quan trong:

- Hien tai cart dang in-memory theo process. Vi vay neu chay >1 process thi cart co the khong dong bo giua process.
- Truoc khi scale ngang, nen dua cart/session vao Redis hoac DB dung chung.

## Healthcheck

Endpoint `GET /health` tra ve trang thai app de platform monitor.

## Deploy Render

Da co file `render.yaml` san:

- Neu repo cua ban co thu muc goc chua `live-shop/`, dung file `render.yaml` o thu muc goc repo.
- Neu ban chi push rieng thu muc `live-shop`, dung file `live-shop/render.yaml`.

1. Push code len GitHub.
2. Tren Render, tao New Blueprint va chon repo.
3. Render se doc `render.yaml`, tao Web Service + Persistent Disk.
4. Mo URL service, vao:
   - `/admin.html` de quan ly
   - `/shop.html` de mua hang

Luu y: Neu khong gan persistent disk thi data va upload se mat sau moi lan redeploy/restart.

## Go Live Nhanh

- Mau env production: `.env.production.example`
- Checklist trien khai 10 phut: `GO-LIVE-CHECKLIST.md`
