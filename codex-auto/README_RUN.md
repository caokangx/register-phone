# cc-auto 运行说明

## 安装
```
pip install -r requirements.txt
python -m uiautomator2 init   # 首次给设备装 atx-agent
```

## 启动服务
```
UIA2_SERIAL=<设备序列号> python main.py     # 或不设，自动选第一台
# 默认监听 :8000
```

## API

### 1) 创建任务
```
POST /tasks
{
  "google_email": "xxx@gmail.com",
  "google_password": "xxx",
  "cc_email": "yyy@xxx.com",
  "device_serial": "可选"
}
→ { "task_id": "...", "status": "pending" }
```

### 2) 轮询任务状态
```
GET /tasks/{id}
→ { "id":..., "status": "pending|running|waiting_code|success|failed", "logs":[...], "error":null }
```

当 `status == "waiting_code"` 时，去用户邮箱拿到验证码后调下一个接口。

### 3) 提交验证码
```
POST /tasks/{id}/code
{ "code": "123456" }
```

之后任务自动继续，最终 `status` 变为 `success` 或 `failed`。
