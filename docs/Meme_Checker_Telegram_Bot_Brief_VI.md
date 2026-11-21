# MEME CHECKER

## Tài liệu yêu cầu phát triển Telegram Bot -- Bot Product Brief v1.0

**Người phụ trách:** @Foxydegenzu\
**Sản phẩm:** Meme Checker\
**Phạm vi:** Telegram Bot -- chức năng Check Token\
**Mục tiêu:** Xây dựng Telegram Bot giúp người dùng kiểm tra nhanh Meme
Coin ngay trong group, đồng thời chuyển đổi người dùng sang Website Meme
Checker để xem phân tích chuyên sâu và đăng ký Premium.

------------------------------------------------------------------------

# 1. Định hướng sản phẩm

Telegram Bot không phải phiên bản thu nhỏ của Website và không cần triển
khai toàn bộ tính năng phân tích chuyên sâu.

Vai trò của Telegram Bot là:

1.  **Fast Checker:** Kiểm tra nhanh token khi người dùng gửi Contract
    Address (CA).
2.  **Group Utility:** Tạo tiện ích cho cộng đồng Telegram, giúp thành
    viên không phải rời group để tra cứu thông tin cơ bản.
3.  **Acquisition Channel:** Giới thiệu Website Meme Checker đến người
    dùng mới.
4.  **Conversion Channel:** Đưa người dùng sang Website để xem thông tin
    đầy đủ, đăng ký tài khoản và nâng cấp Premium.

### Nguyên tắc cốt lõi

**Telegram cung cấp thông tin nhanh và đủ hấp dẫn. Website cung cấp phân
tích sâu và đầy đủ.**

Không cố nhồi tất cả dữ liệu vào một tin nhắn Telegram. Kết quả cần ngắn
gọn, dễ đọc trên điện thoại, có các chỉ số nổi bật và CTA rõ ràng.

------------------------------------------------------------------------

# 2. Phạm vi phát triển

## 2.1. Những chức năng cần làm trong MVP

-   Bot có thể được thêm vào Telegram Group.
-   Tự động phát hiện Contract Address trong tin nhắn.
-   Nhận diện CA thuộc Solana hoặc EVM.
-   Hỗ trợ kiểm tra Solana và BNB Chain trong MVP.
-   Gọi chung Backend API với Website.
-   Trả kết quả Free Checker.
-   Có lệnh `/check` để kiểm tra thủ công.
-   Có lệnh `/start` và `/help`.
-   Có link dẫn về Website ở mỗi kết quả.
-   Có cơ chế cooldown, chống spam và xử lý lỗi.
-   Có thể hoạt động trong group và private chat.

## 2.2. Không nằm trong phạm vi Telegram MVP

Không cần triển khai trực tiếp trong Telegram ở giai đoạn đầu:

-   Bubble Map tương tác.
-   Phân tích chi tiết từng ví.
-   Điều tra lịch sử Dev.
-   Phân tích Bundle Wallet chuyên sâu.
-   KOL History Dashboard.
-   Advanced Narrative Dashboard.
-   Biểu đồ phân tích phức tạp.
-   Hệ thống theo dõi nhiều ví và cảnh báo chuyên sâu.

Các tính năng này được giới thiệu qua CTA để người dùng mở Website.

------------------------------------------------------------------------

# 3. User Flow

## 3.1. Luồng chính trong Group

1.  Admin thêm Meme Checker Bot vào group.
2.  Thành viên gửi một tin nhắn có chứa CA.
3.  Bot kiểm tra tin nhắn có chứa địa chỉ hợp lệ hay không.
4.  Bot xác định chain hoặc kiểm tra các chain được hỗ trợ.
5.  Bot gọi Backend `/api/v1/check`.
6.  Backend lấy dữ liệu từ các API provider.
7.  Bot gửi kết quả tóm tắt vào group.
8.  Người dùng nhấn các link để xem Website hoặc nâng cấp.

### Luồng tổng quát

``` text
Telegram Group
      |
      v
User sends CA
      |
      v
Telegram Bot detects address
      |
      v
Validate CA + Detect Chain
      |
      v
Call Meme Checker Backend
      |
      v
Receive normalized token data
      |
      v
Build Telegram response
      |
      +-----------------------+
      |                       |
      v                       v
  Basic Info             Website CTA
      |                       |
      v                       v
Show in Group           Open Full Analysis
```

## 3.2. Luồng Private Chat

-   User nhấn Start.
-   Bot giới thiệu Meme Checker.
-   User gửi CA hoặc dùng `/check [CA]`.
-   Bot trả kết quả.
-   Bot hướng dẫn mở Website để xem thêm.

## 3.3. Không tự động trả lời mọi chuỗi địa chỉ

Bot cần tránh nhận nhầm địa chỉ ví, địa chỉ giao dịch hoặc chuỗi không
phải token CA.

Yêu cầu:

-   Kiểm tra định dạng theo chain.
-   Ưu tiên nhận diện token CA hợp lệ.
-   Nếu không xác định được chain, hỏi người dùng chọn chain hoặc thông
    báo không hỗ trợ.
-   Có cooldown để tránh spam khi một người gửi nhiều CA liên tiếp.
-   Có thể bỏ qua tin nhắn của bot khác để tránh vòng lặp.

------------------------------------------------------------------------

# 4. Format kết quả Check -- Phần quan trọng nhất

Kết quả Telegram là giao diện sản phẩm quan trọng nhất. Cần thiết kế sao
cho chỉ cần nhìn nhanh trong group, người dùng đã nhận được một lượng
thông tin có giá trị.

## 4.1. Cấu trúc tin nhắn đề xuất

``` text
🚀 MEME CHECKER | TOKEN ANALYSIS

🪙 TOKEN NAME ($SYMBOL)
⛓ Chain: Solana
📍 CA: ABCD...XYZ  [Copy]

━━━━━━━━━━━━━━━━━━

💰 MARKET DATA

Price: $0.000123
Market Cap: $1.25M
Liquidity: $85.4K
Volume 24H: $320K
Price Change 24H: +18.5%

━━━━━━━━━━━━━━━━━━

📊 HOLDER OVERVIEW

Total Holders: 2,450
Top 10 Holders: 24.6%
Largest Holder: 5.2%

━━━━━━━━━━━━━━━━━━

🧠 NARRATIVE

AI-generated summary of the token's
main narrative and project theme.

━━━━━━━━━━━━━━━━━━

🌐 PROJECT INFO

Website: [Open Website]
X: [Open X]
Telegram: [Open Telegram]

━━━━━━━━━━━━━━━━━━

🔎 WANT TO DYOR DEEPER?

Discover more about this token:

• Advanced Narrative
• Dev Wallet Investigation
• Bundle Wallet Analysis
• Bubble Map & Wallet Clusters
• KOL Call History
• Smart Money Insights

👉 FULL TOKEN ANALYSIS:
[Open Meme Checker Website]

⚡ Powered by MEME CHECKER
```

Đây là mẫu cấu trúc, không phải dữ liệu thật. Bot chỉ được hiển thị
những trường Backend thực sự trả về.

## 4.2. Các thông tin cần hiển thị

### A. Token Identity

-   Token Name.
-   Symbol.
-   Chain.
-   Contract Address.
-   Token logo nếu có.
-   Link Explorer.
-   Nút Copy CA.

### B. Market Data

Các chỉ số quan trọng:

  Trường             Ý nghĩa
  ------------------ -----------------------------
  Price              Giá hiện tại
  Market Cap         Vốn hóa nếu có dữ liệu
  FDV                Fully Diluted Valuation
  Liquidity          Thanh khoản
  Volume 24H         Khối lượng giao dịch 24 giờ
  Price Change 1H    Biến động 1 giờ
  Price Change 24H   Biến động 24 giờ
  Pair Age           Tuổi pool giao dịch nếu có

Không bắt buộc mọi trường đều phải xuất hiện nếu API không trả dữ liệu.

**Lưu ý:** Phải phân biệt Market Cap và FDV. Không tự động lấy FDV thay
Market Cap mà không ghi nhãn.

### C. Holder Overview

-   Tổng số holder nếu API hỗ trợ.
-   Top 10 Holder Concentration.
-   Largest Holder Percentage.
-   Burned Supply nếu có dữ liệu xác thực.
-   LP / Pool balance nếu có thể nhận diện.

Đây là phần có giá trị cao vì trader thường muốn biết nguồn cung đang
tập trung như thế nào.

Không gắn nhãn Dev Wallet hoặc Bundle Wallet trong bản Free nếu chưa có
dữ liệu đủ tin cậy.

### D. Narrative

Bot nên trả về một đoạn ngắn từ 2--4 câu:

-   Token đang theo narrative nào?
-   Chủ đề chính của dự án.
-   Vì sao token có thể thu hút sự chú ý.
-   Thông tin social hoặc nguồn tham chiếu nếu có.

Narrative phải được ghi nhận là bản tổng hợp tham khảo. Không tự khẳng
định token đang viral nếu không có dữ liệu social hỗ trợ.

### E. Project Information

-   Website.
-   X.  
-   Telegram.
-   Mô tả dự án nếu có.

Nếu không tìm thấy thì hiển thị `Not Available`, không tạo link hoặc tự
suy đoán.

------------------------------------------------------------------------

# 5. Chiến lược chuyển đổi từ Telegram sang Website

Đây là yêu cầu kinh doanh quan trọng nhất của Bot.

Không nên chỉ gắn một dòng quảng cáo Website ở cuối tin nhắn. Cần thiết
kế kết quả để người dùng hiểu rõ Website có giá trị gì hơn Telegram.

## 5.1. Mô hình Free → Website → Premium

``` text
User sees CA in Telegram Group
              |
              v
       Uses Meme Checker
              |
              v
       Receives Free Result
              |
              v
  Sees locked advanced features
              |
              v
       Clicks Website CTA
              |
              v
     Opens Token Analysis Page
              |
              v
        Creates Account
              |
              v
      Upgrades to Premium
```

## 5.2. Các CTA nên xuất hiện

### CTA 1 -- Full Analysis

Nút chính:

`🔍 View Full Analysis`

Đưa người dùng tới trang kết quả phân tích của chính token đó trên
Website.

Đây là CTA quan trọng nhất.

### CTA 2 -- Unlock Premium

`⚡ Unlock Premium Analysis`

Đưa tới trang Pricing hoặc trang nâng cấp.

### CTA 3 -- Open Website

`🌐 Explore Meme Checker`

Đưa tới Landing Page nếu người dùng chưa biết sản phẩm.

### CTA 4 -- Add Bot to Group

`➕ Add Meme Checker to Your Group`

Đưa tới link Telegram Bot với tham số thêm bot vào group.

## 5.3. Premium Teaser

Sau phần kết quả Free, hiển thị một khu vực ngắn:

``` text
🔒 MORE INTELLIGENCE AVAILABLE

Want to know more about this token?

• Are wallets connected to the Dev?
• Is the supply concentrated in related wallets?
• Which KOLs have mentioned this token?
• What does the Bubble Map reveal?
• Are large wallets buying or selling?

Explore the full intelligence dashboard.

[🔍 VIEW FULL ANALYSIS]
[⚡ UNLOCK PREMIUM]
```

Chỉ giới thiệu tính năng khi Backend hoặc roadmap sản phẩm thực sự hỗ
trợ. Nếu chưa ra mắt, ghi rõ `Coming Soon`.

## 5.4. Deep Link theo CA

Không đưa người dùng về trang chủ chung chung.

Mỗi token cần có một URL riêng, ví dụ:

``` text
https://YOUR_DOMAIN.com/check/solana/TOKEN_CA
https://YOUR_DOMAIN.com/check/bsc/TOKEN_CA
```

Khi người dùng nhấn nút trong Telegram:

-   Website mở đúng token.
-   Tự động tải dữ liệu.
-   Người dùng không phải nhập lại CA.
-   Nếu chưa đăng nhập, có thể xem dữ liệu Free.
-   Nếu muốn dùng Premium, Website hiển thị bước đăng ký/nâng cấp.

Cần thống nhất route thực tế với Website team trước khi tích hợp.

## 5.5. Tracking Conversion

Nên gắn tracking parameters cho link Website:

``` text
?utm_source=telegram
&utm_medium=group_bot
&utm_campaign=token_check
```

Có thể bổ sung:

-   Telegram Group ID.
-   User ID nội bộ hoặc attribution ID phù hợp chính sách riêng tư.
-   Token CA.
-   Chain.
-   Thời điểm click.

Không đưa API key, bot token hoặc thông tin nhạy cảm vào URL.

Mục tiêu đo lường:

-   Số CA được check.
-   Số group có bot.
-   Số user sử dụng bot.
-   Số lần click Website.
-   Số tài khoản đăng ký từ Telegram.
-   Số người nâng cấp Premium.

------------------------------------------------------------------------

# 6. Bot Commands

  Command       Chức năng
  ------------- -------------------------
  `/start`      Giới thiệu Bot
  `/help`       Hướng dẫn sử dụng
  `/check CA`   Check token thủ công
  `/about`      Giới thiệu Meme Checker
  `/website`    Mở Website
  `/upgrade`    Mở trang Premium

Không cần tạo quá nhiều lệnh trong MVP. Trải nghiệm chính vẫn là người
dùng gửi CA trực tiếp vào group.

## 6.1. Nội dung `/start`

Bot nên gửi tin nhắn:

``` text
👋 Welcome to MEME CHECKER

Your quick Meme Coin research assistant.

Check any supported token directly in Telegram.

🔎 What you can do:
• Check token market data
• View holder distribution
• Discover project information
• Get a quick narrative summary

Want deeper intelligence?

Explore:
• Bubble Map
• Dev Wallet Analysis
• Bundle Wallet Tracking
• KOL Intelligence
• Smart Alerts

👉 Open Meme Checker Website
```

------------------------------------------------------------------------

# 7. Technical Requirements

## 7.1. Kiến trúc

Telegram Bot chỉ là một client của Core Backend.

``` text
Telegram Group / Private Chat
              |
              v
        Telegram Bot
              |
              v
        Core Backend API
              |
       +------+------+
       |             |
       v             v
  Token Service  User/Access
       |
       v
  Data Providers
       |
       v
 Normalized Result
       |
       v
 Telegram Formatter
       |
       v
 Send Message
```

Không gọi từng API provider trực tiếp từ Bot nếu Backend đã xử lý. Không
tạo một hệ thống phân tích dữ liệu độc lập chỉ dành cho Telegram.

## 7.2. API cần tích hợp

Sử dụng API nội bộ:

  Method   Endpoint                                     Mục đích
  -------- -------------------------------------------- -------------
  POST     `/api/v1/check`                              Check CA
  GET      `/api/v1/tokens/:chain/:address`             Token Info
  GET      `/api/v1/tokens/:chain/:address/market`      Market Data
  GET      `/api/v1/tokens/:chain/:address/holders`     Holder Data
  GET      `/api/v1/tokens/:chain/:address/narrative`   Narrative

Các endpoint có thể được gộp thành một API response tổng hợp để giảm số
lần gọi.

## 7.3. JSON Response Contract

Backend và Bot cần thống nhất response schema.

Ví dụ:

``` json
{
  "success": true,
  "data": {
    "chain": "solana",
    "address": "TOKEN_CA",
    "token": {
      "name": "Example Token",
      "symbol": "EXAMPLE",
      "logo": null
    },
    "market": {
      "price_usd": 0.000123,
      "market_cap_usd": 1250000,
      "fdv_usd": 1500000,
      "liquidity_usd": 85400,
      "volume_24h_usd": 320000,
      "price_change_24h": 18.5
    },
    "holders": {
      "total": 2450,
      "top10_percentage": 24.6,
      "largest_holder_percentage": 5.2
    },
    "narrative": {
      "summary": "Example narrative summary",
      "source": "project_metadata"
    },
    "project": {
      "website": null,
      "x": null,
      "telegram": null
    },
    "updated_at": "2026-11-21T00:00:00Z"
  }
}
```

Đây là schema minh họa, không phải dữ liệu thực tế. Các trường có thể
null và Bot phải xử lý được.

## 7.4. Telegram Message Formatting

Yêu cầu:

-   Sử dụng Telegram HTML hoặc MarkdownV2.
-   Escape các ký tự đặc biệt.
-   Kiểm soát độ dài tin nhắn.
-   Chia tin nhắn nếu vượt giới hạn.
-   Có inline keyboard với các CTA.
-   Không gửi nhiều tin nhắn liên tiếp nếu một tin nhắn là đủ.
-   Ưu tiên thông tin quan trọng lên đầu.
-   Hiển thị thời gian cập nhật.

## 7.5. Group Permissions

Cần kiểm tra Telegram Bot Privacy Mode:

-   Nếu bot cần đọc CA trong các tin nhắn thông thường của group, phải
    cấu hình quyền phù hợp.
-   Có thể sử dụng lệnh hoặc mention khi cần.
-   Chỉ xử lý tin nhắn cần thiết.
-   Không lưu toàn bộ nội dung trò chuyện của group.
-   Không gửi tin nhắn ngoài mục đích check token.

Admin cần có thể thêm bot và cấp quyền cần thiết.

------------------------------------------------------------------------

# 8. Error Handling và Anti-Spam

Các trường hợp cần xử lý:

  Trường hợp                  Bot phản hồi
  --------------------------- -----------------------------------
  CA sai định dạng            Invalid Contract Address
  Chain không hỗ trợ          Unsupported Chain
  Không tìm thấy token        Token Not Found
  API lỗi                     Unable to fetch data, try again
  Rate limit                  Please wait before checking again
  Thiếu dữ liệu               Một số thông tin chưa khả dụng
  Token chưa có market pair   Market data unavailable

### Anti-Spam

-   Cooldown theo user và group.
-   Chống gửi trùng CA liên tục.
-   Bỏ qua tin nhắn do bot khác gửi.
-   Cache kết quả trong khoảng thời gian phù hợp.
-   Giới hạn số request đồng thời.
-   Có log lỗi và theo dõi API usage.

------------------------------------------------------------------------

# 9. UI/UX của Telegram Messages

Telegram không cần giao diện đồ họa phức tạp. Cần tập trung vào cách
trình bày nội dung.

### Quy tắc

1.  Token Name và Symbol nổi bật.
2.  Giá và Market Cap dễ nhìn.
3.  Holder Overview ngắn gọn.
4.  Narrative không quá dài.
5.  Project Links dễ nhấn.
6.  CTA Website nằm ở vị trí dễ thấy.
7.  Premium teaser không chiếm quá nhiều diện tích.
8.  Tin nhắn phải dễ đọc trên điện thoại.

### Mẫu nút Inline Keyboard

Hàng 1: - `🔍 Full Analysis`

Hàng 2: - `⚡ Premium` - `🌐 Website`

Hàng 3: - `➕ Add Bot to Group`

Ưu tiên nút Full Analysis làm CTA chính.

------------------------------------------------------------------------

# 10. Task Breakdown -- @Foxydegenzu

## P0 -- Bắt buộc cho MVP

  ID      Task                           Kết quả bàn giao
  ------- ------------------------------ ----------------------------------
  TG-01   Khởi tạo Telegram Bot          Bot hoạt động
  TG-02   Cấu hình Bot Privacy / Group   Bot đọc được CA theo yêu cầu
  TG-03   Nhận diện CA                   Phát hiện địa chỉ trong tin nhắn
  TG-04   Chain Detection                Solana và BNB Chain
  TG-05   Kết nối Backend                Gọi `/api/v1/check`
  TG-06   Format Token Result            Tin nhắn kết quả chuẩn
  TG-07   Inline Keyboard                CTA dẫn Website
  TG-08   Lệnh `/start` và `/help`       Onboarding
  TG-09   Lệnh `/check`                  Check thủ công
  TG-10   Error Handling                 Xử lý lỗi
  TG-11   Anti-Spam                      Cooldown và cache
  TG-12   Group Testing                  Test group thực tế

## P1 -- Sau khi MVP hoạt động

-   `/upgrade`.
-   Theo dõi conversion click Website.
-   Group admin settings.
-   Giới hạn usage theo group.
-   Hỗ trợ nhiều token CA trong một tin nhắn nếu có nhu cầu.
-   Tùy chỉnh ngôn ngữ tin nhắn.

## P2 -- Không triển khai ở vòng đầu

-   Smart Alerts.
-   Wallet Tracking.
-   Bubble Map trong Telegram.
-   KOL Alerts.
-   Dev Wallet Alerts.
-   Bundle Wallet Monitoring.

------------------------------------------------------------------------

# 11. Acceptance Criteria -- Tiêu chí nghiệm thu

Telegram MVP được nghiệm thu khi:

-   [ ] Bot có thể được thêm vào group.
-   [ ] Bot nhận diện CA trong tin nhắn theo quyền đã cấu hình.
-   [ ] Bot hỗ trợ Solana và BNB Chain.
-   [ ] Bot gọi được Core Backend.
-   [ ] Trả về Token Identity.
-   [ ] Trả về Market Data khi có dữ liệu.
-   [ ] Trả về Holder Overview khi có dữ liệu.
-   [ ] Trả về Narrative cơ bản.
-   [ ] Trả về Project Links khi có dữ liệu.
-   [ ] Có nút Full Analysis dẫn tới đúng token trên Website.
-   [ ] Có nút Premium.
-   [ ] Có xử lý CA sai và API lỗi.
-   [ ] Có chống spam và cache.
-   [ ] Không bị loop với tin nhắn từ bot khác.
-   [ ] Tin nhắn hiển thị tốt trên Telegram Mobile.

### KPI mục tiêu ban đầu

  KPI                                    Mục tiêu
  ------------------------------------ ----------
  CA detection accuracy trên bộ test        ≥ 99%
  Check success rate                        ≥ 95%
  Response time P95                      ≤ 7 giây
  Website CTA có trong kết quả               100%
  Duplicate response                        Gần 0
  Critical bot errors                           0

------------------------------------------------------------------------

# 12. Phối hợp với các thành viên khác

### Với @bnbcabal999

Cần thống nhất:

-   API cung cấp Market Data.
-   API cung cấp Holder Data.
-   Dữ liệu Narrative lấy từ đâu.
-   Chain Detection và địa chỉ hợp lệ.
-   Trường nào có thể thiếu.
-   Rate limit và cache policy.

### Với @timlecrt

Cần thống nhất:

-   Endpoint Backend.
-   Request / Response JSON.
-   Cơ chế Authentication nếu có.
-   Rate limit.
-   Error codes.
-   Quyền Free/Premium.
-   URL token detail trên Website.

### Với @ricofintech và @podnhoerc

Cần thống nhất:

-   Website route dành cho từng token.
-   Thiết kế trang Analysis Result.
-   URL Full Analysis.
-   CTA và nội dung Premium.
-   Format hiển thị dữ liệu giữa Website và Telegram.

------------------------------------------------------------------------

# 13. Kế hoạch triển khai đề xuất

  Giai đoạn   Công việc
  ----------- -------------------------------------------
  Ngày 1      Dựng Bot, cấu hình Telegram, test nhận CA
  Ngày 2      Kết nối Backend và Chain Detection
  Ngày 3      Hoàn thiện Token Result Formatter
  Ngày 4      Inline Keyboard và Website CTA
  Ngày 5      Anti-Spam, Error Handling
  Ngày 6      Test Solana và BNB Chain
  Ngày 7      Test group thực tế, sửa lỗi và bàn giao

Thời gian trên là kế hoạch mục tiêu, phụ thuộc vào tiến độ Backend và
API.

------------------------------------------------------------------------

# 14. Định hướng cuối cùng dành cho Telegram Developer

Hãy xây dựng Telegram Bot theo tư duy:

**CHECK FAST -- SHOW VALUE -- DRIVE TO WEBSITE.**

Bot cần đủ tốt để cộng đồng muốn giữ lại trong group và sử dụng thường
xuyên. Nhưng giá trị chuyên sâu, phân tích ví và các tính năng trả phí
phải được thể hiện rõ trên Website.

Ba điều quan trọng nhất:

1.  Bot phải nhận CA nhanh và trả kết quả ổn định.
2.  Tin nhắn kết quả phải chứa những thông tin trader thực sự quan tâm.
3.  Mỗi lần check phải có đường dẫn đến đúng trang phân tích token trên
    Meme Checker Website.

Không xây dựng một bot chỉ trả lời "Token Name -- Price -- Market Cap".
Hãy biến mỗi kết quả check thành một điểm chạm giúp người dùng khám phá
và đăng ký Meme Checker.

------------------------------------------------------------------------

*Tài liệu Meme Checker -- Telegram Bot Product Brief v1.0. Các endpoint,
trường dữ liệu và Website URL cần được thống nhất với Backend và Website
team trước khi tích hợp.*
