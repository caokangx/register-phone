# 输入信息
google账号、google密码、cc账号。
# 执行步骤：
## 切换账户
1. 启动 Play 商店：`d.app_start("com.android.vending", stop=True)`
2. 点击(//*[@resource-id="com.android.vending:id/0_resource_name_obfuscated"])[6]
3. 判断是否存在 `//*[@content-desc="目前的登录者是<google账号>"]`，存在说明已经是目标账号，按返回键退出本章节；不存在则继续下面的步骤。
4. 点击//androidx.cardview.widget.CardView
5. 点击//*[@text="添加其他账号"]
6. 点击(//android.widget.TextView)[5]
7. //android.widget.EditText输入google账号，然后回车
8. //android.widget.EditText，先点击聚焦，然后使用 `d.shell('input text "<google密码>"')` 输入google密码，然后回车
9. 点击//*[@text="我同意"]
10. 点击(//*[@resource-id="com.android.vending:id/0_resource_name_obfuscated"])[6]
11. 点击//androidx.cardview.widget.CardView
12. 点击//*[@text="管理此设备上的账号"]
13. 遍历//androidx.recyclerview.widget.RecyclerView，如果是一个Google账号，且不是当前添加的账号，则点击。注意，这个列表里面，属于账号的特征是：有一个：resource-id="android:id/title"，还有一个：resource-id="android:id/summary"。summary为Google的即为需要判断的账号。
14. 点击进入某个账号后，需要点击//android.widget.Button，来删除该账号，然后点击//*[@text="移除"]来确认。确认完毕后会重新回到账号列表页面，重复13步骤，直到只有一个新增的账号为止。

## 检查订阅状态
1. 启动 Play 商店：`d.app_start("com.android.vending", stop=True)`
2. 点击(//*[@resource-id="com.android.vending:id/0_resource_name_obfuscated"])[6]（右上角头像）
3. 点击//*[@text="付款和订阅"]
4. 点击//*[@text="订阅"]
5. 如果当前窗口存在//*[@text="Claude by Anthropic"]，说明该 Google 账号已有 Claude 订阅，视为异常，直接退出流程。

## 充值claude账号
1. 清理数据：d.app_clear('com.anthropic.claude')
2. 打开这个app：d.app_start('com.anthropic.claude')
3. 点击//*[@text="Enter your email"]
4. //android.widget.EditText，输入cc账号，然后enter
5. 此时需要等待用户输入验证码
6. //android.widget.EditText输入验证码。
7. 点击//*[@text="Upgrade"]
8. 往下滚动一页，点击//*[@text="US$250.00"]
9. 点击//*[@text="Get Max plan"]
10. 点击//android.widget.Button
11. 如果有//android.widget.EditText，则先点击聚焦，然后使用 `d.shell('input text "<google密码>"')` 输入google账号的密码，然后enter。
