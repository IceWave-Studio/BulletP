# BulletP 数据库迁移规范（Alembic）

## 目标
- 使用 Alembic 管理数据库 schema 变更
- 保证 dev/prod schema 一致可追溯
- 避免直接改库导致线上不可控

---

## 目录结构
- `backend/app/models.py`：SQLAlchemy 模型定义（唯一真源）
- `backend/alembic/`：迁移脚本目录
- `backend/alembic.ini`：Alembic 配置文件
- `backend/.env.example`：环境变量示例（不提交真实密码）

---

## 环境变量约定
必须设置：
- `ENV=dev` 或 `ENV=prod`
- `DATABASE_URL=...`

示例（dev SQLite）：
```bash
export ENV=dev
export DATABASE_URL="sqlite:///./bulletp.db"
示例（prod MySQL）：

export ENV=prod
export DATABASE_URL="mysql+pymysql://user:password@127.0.0.1:3306/bulletp?charset=utf8mb4"


注意：.env* 文件不应提交到 Git，只提交 .env.example

日常开发：新增/修改字段流程（DEV）

修改 app/models.py

生成迁移：

ENV=dev alembic revision --autogenerate -m "add xxx"


检查生成的迁移文件

是否包含破坏性操作（drop/alter type）

SQLite 是否支持（SQLite 常不支持 ALTER COLUMN TYPE）

应用迁移：

ENV=dev alembic upgrade head


启动服务验证：

ENV=dev python -m uvicorn app.main:app --reload --port 8000

上线：迁移流程（PROD / MySQL）

备份数据库：

mysqldump -u <user> -p bulletp > bulletp_backup_$(date +%F).sql


拉取最新代码：

git pull


执行迁移：

ENV=prod alembic upgrade head


重启服务：

sudo systemctl restart bulletp.service

SQLite 限制说明（重要）

SQLite 对 schema 变更支持有限，尤其是：

ALTER COLUMN TYPE 常会失败

推荐策略：

尽量用 “新增字段 + 迁移数据 + 废弃旧字段” 的方式

或 dev 环境直接使用 MySQL（与生产一致）

常用命令

查看当前版本：

alembic current


查看迁移历史：

alembic history


回滚一个版本：

alembic downgrade -1


升级到最新：

alembic upgrade head


---

# ✅ 现在你要做的“下一步”
你先执行 **第 1 部分：把 chore/env-split commit 干净**。

你把下面三条命令的输出贴给我（不用全贴，关键信息就行）：
```bash
git status
git log --oneline --decorate -n 8
ls alembic/versions