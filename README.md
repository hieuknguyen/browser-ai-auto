# Browser AI Auto

Ứng dụng React + Python điều khiển Google Chrome bằng Gemini. Có thể chạy một yêu cầu hoặc đưa vào danh sách công việc để AI thực hiện lần lượt.

## Khởi chạy

Máy cần Node.js 22+, Python 3.12+ và Google Chrome. Trong thư mục project:

```powershell
uv sync --python 3.12
npm install
npm run dev
```

Mở địa chỉ giao diện được hiển thị khi khởi chạy (cổng Vite mặc định là 5174). Nhập Gemini API key ở phần cấu hình AI, hoặc đặt `GEMINI_API_KEY` trong `.env` trên máy. Các tùy chọn model và endpoint hiện có vẫn được hỗ trợ.

## Chạy danh sách công việc

1. Chọn **Danh sách công việc** trong bảng điều khiển AI.
2. Nhập từng công việc vào một dòng riêng; có thể dán nhiều dòng rồi thêm vào danh sách.
3. Thêm, xóa hoặc đổi thứ tự bằng nút lên/xuống trước khi chạy.
4. Chọn phiên Chrome có sẵn hoặc tạo phiên mới, đặt trang bắt đầu rồi chạy danh sách.

Ví dụ ba công việc liên tiếp:

```text
Mở trang sản phẩm và tìm bàn phím không dây.
Lọc sản phẩm còn hàng, sắp xếp giá từ thấp đến cao.
Tổng hợp tên và giá của 5 sản phẩm đầu tiên.
```

- Tối đa 50 công việc. Giới hạn thao tác AI áp dụng riêng cho từng công việc, tối đa 50 thao tác/việc.
- AI hoàn tất việc hiện tại rồi mới bắt đầu việc kế tiếp. Cùng một phiên Chrome và tab đang thao tác được giữ xuyên suốt danh sách, bao gồm trạng thái đăng nhập và dữ liệu đã nhập.
- Kết quả các việc trước được cung cấp làm ngữ cảnh cho việc tiếp theo. Có thể chọn từng việc để xem kết quả và các thao tác.
- Mặc định danh sách dừng khi một việc lỗi. Bật **tiếp tục khi lỗi** nếu muốn chạy các việc sau dù việc trước thất bại.
- **Dừng** sẽ hủy việc đang chạy và giữ phiên Chrome. **Tiếp tục** thử lại việc lỗi hoặc chưa hoàn tất theo thứ tự, bỏ qua các việc đã hoàn tất. Thao tác đã thực hiện trong một việc bị dừng không được hoàn tác.
- Một danh sách chạy tại một thời điểm. Phiên Chrome của danh sách được giữ riêng trong suốt lần chạy để các yêu cầu khác không xen vào giữa các việc.
- Tải lại giao diện vẫn xem được tiến độ khi backend đang chạy. Lịch sử danh sách hiện lưu trong bộ nhớ và được xóa khi khởi động lại backend.

## API danh sách

`POST /api/ai/workflows` nhận dữ liệu như sau:

```json
{
  "name": "Kiểm tra sản phẩm",
  "instructions": [
    "Tìm danh sách sản phẩm trên trang hiện tại.",
    "Mở chi tiết sản phẩm đầu tiên.",
    "Tổng hợp tên và giá sản phẩm đang xem."
  ],
  "startUrl": "https://example.com",
  "maxSteps": 20,
  "continueOnError": false
}
```

Thêm `sessionId` để dùng phiên Chrome có sẵn. Các endpoint liên quan:

| Thao tác | Endpoint |
| --- | --- |
| Xem tất cả danh sách | `GET /api/ai/workflows` |
| Xem một danh sách | `GET /api/ai/workflows/{id}` |
| Dừng danh sách | `DELETE /api/ai/workflows/{id}` |
| Tiếp tục việc chưa hoàn tất | `POST /api/ai/workflows/{id}/resume` |

WebSocket `/events` phát sự kiện `ai:workflow` khi tiến độ thay đổi. Trạng thái ban đầu và `/api/status` có trường `aiWorkflows`. Trường `revision` giúp giao diện bỏ qua cập nhật cũ.

## Kiểm tra

```powershell
npm run build
.venv\Scripts\python.exe -m pytest backend/tests -q --basetemp artifacts/pytest-local
```

Các bài kiểm tra danh sách dùng AI giả lập; bài kiểm tra tích hợp thao tác trên Chrome với trang cục bộ, không gọi Gemini và không cần API key thật.

Nếu Windows báo `EBUSY` vì một bản ứng dụng đang giữ file trong `dist`, dừng bản ứng dụng đó trước khi build, hoặc dùng `npm run build -- --emptyOutDir false` để tạo bản mới và giữ lại các file build cũ.
