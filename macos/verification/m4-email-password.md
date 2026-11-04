# M4-7：改登录邮箱、改密码要输入当前密码

- 分支：`mac/feat/email-password`
- 日期：2026-11-04
- 状态：**通过**
- 结论：`PUT /users/me` 改登录邮箱、或用它设新密码时，要带当前密码（`currentPassword`）；不带返回 400 `Current password is required`，带错返回 400 `Wrong password`。只改名字、头像颜色，或邮箱没变时不用。网页端的 账号设置 → 个人资料 改了邮箱时多出一个“当前密码”框。

## 为什么

上游改邮箱不校验密码：手机解锁着、或会话被盗时，别人改掉登录邮箱再走“忘记密码”，账号就被拿走了。改密码的正式接口（`POST /auth/change-password`）本来就要当前密码，`PUT /users/me` 里旧的 `password` 字段却不用，一并补上。

## 规则

| 情况 | 要当前密码 |
|---|---|
| 改登录邮箱（不区分大小写，邮箱不变不算） | 要 |
| 用 `PUT /users/me` 的 `password` 设新密码 | 要；但管理员建的、必须改密码（`shouldChangePassword`）的用户第一次设密码不用（网页首次登录改密码页走这里，它不问旧密码） |
| 改名字、头像颜色 | 不要 |
| 没有密码的用户（只用 OAuth 登录） | 都不要，他们没有密码可输 |

- 官方服务器没有 `currentPassword`，会忽略它，照旧不校验。Pixcellar 先不带密码提交，收到 `Current password is required` 才让用户输密码，所以连官方服务器时不问。

## 实现

- `UserUpdateMeDto` 加 `currentPassword`（可选）；`UserService.updateMe` 先调 `checkCurrentPassword`。
- `UserRepository.getForChangePassword` 多取 `shouldChangePassword`（`queries/user.repository.sql` 同步）。
- OpenAPI 规范和 TS SDK 重新生成；`UserProfileSettings.svelte` 邮箱改了时显示当前密码框；新增翻译 `current_password`、`change_email_password_description`。

## 验证

- 单元测试：`user.service.spec.ts`、`auth.service.spec.ts` 122/122。
- 数据库测试（medium）：`user.service.spec.ts` 32/32（新增 4 个：改邮箱要密码、改名字不要、设新密码要、必须改密码的用户第一次不要），`auth.service.spec.ts` 7/7。本机没有 Docker，临时把 globalSetup 指向本地 Postgres（vchord）跑的，跑完删除。
- 端到端：[`scripts/m4_email_password.py`](../scripts/m4_email_password.py)，在 2291 测试服务器（mac.7 + 这个分支的 `server/dist`）上 12/12，连续 3 次通过：
  - 不带密码改邮箱 400、带错密码 400 且邮箱不变；
  - 改名字同时传原邮箱 200；
  - 带对密码改邮箱 200，新邮箱能登录、旧邮箱不能；
  - 设新密码不带旧密码 400、带了 200，新密码能登录；
  - 必须改密码的用户第一次设密码 200。
- 网页：`svelte-check` 没有新增错误（原有 7 个在无关的测试文件里）。
