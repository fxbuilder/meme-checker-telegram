# Meme Checker Telegram Bot

Meme Checker trả kết quả quét token trên **15 chain** ngay trong Telegram. Bot hoạt động trong DM và group, nhận địa chỉ contract (CA) trực tiếp hoặc qua lệnh `/check`. Card hiển thị dữ liệu thị trường, **Quick Checks** (Top 10, Holders, Dex Paid, Tax, LP Lock, Dev), narrative và thông tin dự án khi có dữ liệu. CA xuất hiện đầy đủ một lần trên dòng monospace riêng để copy.

Bot có **ba chế độ hiển thị**: `standard` (mặc định), `short` và `detailed`. Xem [docs/card-redesign.md](docs/card-redesign.md) và [docs/card-ui-and-chains.md](docs/card-ui-and-chains.md).

- **Bot staging** [@MemeCheckerStagingBot](https://t.me/MemeCheckerStagingBot)
- **Nhánh làm việc** `mc/final-ui` (chưa push)
- **BASELINE UI CHÍNH THỨC** [docs/final-ui-baseline.md](docs/final-ui-baseline.md) — đã khoá, không thiết kế lại
- **Tài liệu UI và chain** [docs/card-ui-and-chains.md](docs/card-ui-and-chains.md)
- **Checklist nghiệm thu** [docs/acceptance-checklist.md](docs/acceptance-checklist.md)

Staging dùng dữ liệu mẫu có nhãn `[mock]`. Ba phần cần nghiệm thu tích hợp là Core API thật, trang Full Analysis theo token và trang Premium trên website.

## 1. Thử bot staging

1. Mở [@MemeCheckerStagingBot](https://t.me/MemeCheckerStagingBot) và gửi `/start`.
2. Gửi `/help` hoặc bấm **Menu** trong DM để xem danh sách lệnh.
3. Dán một địa chỉ mẫu bên dưới hoặc gửi `/check` kèm địa chỉ. Nếu bot staging chưa phản hồi, kiểm tra tiến trình bot đã được bật trên máy chạy staging.

| Chain | CA mẫu |
| --- | --- |
| Solana | `FiXtUrE111111111111111111111111111111111111` |
| BNB Smart Chain | `0xabcdef0123456789abcdef0123456789abcdef01` |

| Lệnh | Công dụng |
| --- | --- |
| `/start` | Mở màn hình giới thiệu. |
| `/help` | Xem hướng dẫn và danh sách lệnh. |
| `/check <CA>` | Quét địa chỉ contract chỉ định. |
| `/check <chain> <CA>` | Quét trên chain cụ thể, ví dụ `/check base 0x…`. |
| `/chains` | Danh sách chain và dữ liệu từng chain có thể hiển thị. |
| `/standard` | Card chuẩn (mặc định). |
| `/short` | Card rút gọn. |
| `/detail` | Card đầy đủ kỹ thuật. |
| `/about` | Xem giới thiệu Meme Checker. |
| `/website` | Mở website khi URL đã được cấu hình. |
| `/upgrade` | Mở trang nâng cấp khi `PREMIUM_URL` đã được cấu hình. |

Địa chỉ `0x…` có thể tồn tại trên nhiều chain, nên bot **sẽ hỏi bạn chọn chain** thay vì tự đoán. Gõ `/check <chain> <CA>` để chỉ định trước.

Trong group, gõ `/` để xem gợi ý lệnh. Có thể dùng `/check@TênBot <CA>` để gọi đúng bot khi group có nhiều bot.

## 2. Chạy một bản test riêng trên Windows

Chuẩn bị Git, Node.js và npm. Dùng phiên bản Node theo trường `engines` trong `package.json` nếu repo có khai báo. Nếu đã có bản clone trên máy, mở PowerShell trong thư mục dự án và chuyển đến bước cài đặt.

```powershell
$repoUrl = Read-Host 'Paste the GitHub HTTPS repository URL'
git clone --branch demo/offline-mvp $repoUrl meme-checker-telegram
cd meme-checker-telegram
```

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

1. Tạo bot test riêng qua [@BotFather](https://t.me/BotFather) hoặc dùng bot test đã được cấp cho bạn.
2. Mở `.env` trên máy và điền token vào đúng biến được ghi trong `.env.example`. Xem `.env.example` để xác định các biến tùy chọn và thiết lập quyền chủ bot nếu có.
3. Giữ `.env`, token bot và API key trên máy. Khi cần bàn giao mẫu cấu hình, dùng `.env.example` với giá trị mẫu.
4. Giữ cấu hình mock mặc định cho lượt test đầu tiên. Điền URL website sau khi đội Website xác nhận đường dẫn.

```powershell
npm start
```

Đợi log `Connected as @...` và kiểm tra username trùng với bot bạn định test. Giữ cửa sổ PowerShell mở khi thử bot. Dùng `Ctrl+C` để dừng tiến trình và chạy lại `npm start` sau khi đổi cấu hình. Mỗi token dùng một tiến trình polling tại một thời điểm.

## 3. Thử tự nhận CA trong group

1. Tạo một group test riêng và thêm bot đang chạy.
2. Group Privacy của bot phải **TẮT** qua [@BotFather](https://t.me/BotFather) để bot đọc được tin nhắn thường. Kiểm tra bằng `getMe`: `can_read_all_group_messages` phải là `true`. Nếu đổi khi bot đã ở trong group, gỡ và thêm lại bot. **Không cần quyền admin** cho chức năng hiện tại.
3. Dán CA Solana dạng tin nhắn thường. Card `[mock]` xuất hiện.
4. Với địa chỉ `0x…`, bot sẽ hiện nút chọn chain — chọn chain rồi card hiện ra.

### Kiểm thử nhanh

| Thử | Kết quả mong đợi |
| --- | --- |
| Dán CA Solana hoặc BNB vào DM và group đã cấu hình | Bot trả card `[mock]` đúng chain. |
| Copy dòng CA trên card | Clipboard chứa toàn bộ contract đúng từng ký tự. |
| Gửi lại cùng CA trong cùng chat sau 20 giây | Bot bỏ qua lượt trùng trong cửa sổ 60 giây. |
| Gửi `/check invalid` | Bot trả `Invalid Contract Address`. |
| Gửi `/check 0xabcdef0123456789abcdef0123456789abcdef02` | Bot trả `[mock] Token Not Found`. |
| Gọi `/website` hoặc `/upgrade` khi chưa cấu hình URL | Bot thông báo website hoặc Premium chưa sẵn sàng. |

### Chạy kiểm thử offline

Chạy `npm run` để xem các script của checkout hiện tại. Nếu repo có script `test`, chạy `npm test`. Dùng [checklist nghiệm thu](docs/acceptance-checklist.md) để chạy thêm bài QA của nhánh hoặc ghi lại kết quả kiểm thử trên Telegram thật.

## 4. Áp bộ 18 custom icon

Khi chạy một bản clone mới, thiết lập theme cho bot đang test. Card dùng emoji mặc định cho đến khi chủ bot áp mapping. Với luồng staging này, tài khoản **sở hữu bot** cần Telegram Premium để bot gửi custom emoji trong DM và group. Người xem card không cần mua Premium để thử bot.

1. Dùng tài khoản có quyền chủ bot để mở **DM của bot test**.
2. Sao chép **nguyên dòng JSON** dưới đây và gửi dạng tin nhắn thường.
3. Xem preview **Solana** và **BNB**. Chọn **✅** theo lời nhắc để áp theme hoặc **❌** để hủy.
4. Sau khi bot xác nhận, quét một card mới trong DM và group. Nếu dùng lại cùng CA trong cùng chat, đợi ít nhất 60 giây.

```json
{"🚀":"5292284235711784694","🟣":"5291923604487808793","🟡":"5291751363414336197","🌐":"5402068075153476626","🌍":"5402068075153476626","✖️":"5195042564062865767","✈️":"5291812201626084541","⚡":"5291824180289872393","📊":"5431577498364158238","👥":"5372926953978341366","🧠":"5237799019329105246","🔎":"5188311512791393083","🔐":"5472308992514464048","❗️":"5467928559664242360","⏳":"5451732530048802485","⛓️":"5318757666800031348","➡️":"5321300317504030049","📌":"5321006159488892145"}
```

Giữ ID ở dạng chuỗi JSON để bảo toàn mọi chữ số. 18 mục bao phủ logo chain, website và mạng xã hội, các tiêu đề phân tích, trạng thái chờ và các mục điều hướng. Một card chỉ hiện những icon phù hợp với chain và nội dung của card đó. 🪙 dùng emoji chuẩn.

Các pack dùng trong mapping gồm [CryptoIcons](https://t.me/addemoji/CryptoIcons), [RestrictedEmoji](https://t.me/addemoji/RestrictedEmoji) và [SM Animated](https://t.me/addemoji/emojipack_sm). Xem [điều kiện gửi custom emoji trong Telegram Bot API](https://core.telegram.org/bots/api#html-style).

| Hiện tượng | Kiểm tra |
| --- | --- |
| Gửi JSON mà chưa thấy preview | Kiểm tra đang ở DM của đúng bot, dùng tài khoản chủ bot và gửi một dòng JSON nguyên vẹn. |
| Card mới còn emoji thường | Kiểm tra bot đã xác nhận ✅, tài khoản sở hữu bot có Premium và bạn đang test đúng tiến trình. |
| `/check` hoạt động nhưng dán CA vào group không thấy phản hồi | Kiểm tra quyền đọc tin nhắn thường, cooldown và cửa sổ chống trùng. |
| Bot báo lỗi `409 Conflict` khi polling | Kiểm tra có tiến trình khác đang chạy cùng token và dừng bản test trùng. |

## 5. Tích hợp Core API và website

| Hạng mục | Đầu vào cần từ đội phụ trách | Kiểm tra bàn giao |
| --- | --- | --- |
| Core API | Endpoint staging và contract cho `POST /api/v1/check`, thông tin xác thực nếu cần, payload và mã lỗi cho Solana và BNB. | Nối adapter hoặc cấu hình theo code hiện tại. Quét một CA thật mỗi chain trong DM và group test, đối chiếu dữ liệu trả về với Core. |
| Full Analysis | URL qua cấu hình `TOKEN_PAGE_BASE_URL` và route trang token đã thống nhất với đội Website. | Bấm nút và xác nhận trang mở đúng chain và đầy đủ CA vừa quét. |
| Premium | URL trang Pricing/VIP qua `PREMIUM_URL`. | Bấm **Unlock Premium** và thử `/upgrade` để xác nhận dẫn đúng trang. |
| Website | URL landing page, dùng biến tương ứng được ghi trong `.env.example` nếu có. | Thử `/website` và nút Website khi hiện trên card. |

**Premium Teaser** là khối **WANT TO DYOR DEEPER?** ở gần cuối card, sau phần kết quả miễn phí. Tính năng phân tích nâng cao do website cung cấp. Đội Core và Website xác nhận tiến độ để nội dung teaser ghi **Coming Soon** cho các tính năng chưa ra mắt.

Sau khi đổi cấu hình live, chạy lại bot và ghi kết quả vào [checklist nghiệm thu](docs/acceptance-checklist.md).

## Tài liệu Telegram

- [Group Privacy và quyền đọc tin nhắn](https://core.telegram.org/bots/features#privacy-mode)
- [Danh sách lệnh và nút menu](https://core.telegram.org/bots/features#commands)
