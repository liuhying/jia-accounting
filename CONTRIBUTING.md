# 贡献指南

感谢你对家记账的关注！

## 快速开始

```bash
git clone https://github.com/your-org/jia-accounting.git
cd jia-accounting
cp .env.example .env
npm install
mysql -u root -e "CREATE DATABASE jia_app DEFAULT CHARSET utf8mb4"
mysql -u root jia_app < sql/01_basic.sql
mysql -u root jia_app < sql/02_accounting.sql
mysql -u root jia_app < sql/03_aux.sql
mysql -u root jia_app < sql/04_tax.sql
npm start
```

## 项目结构

- `app.js` — Express 入口，挂载所有路由
- `routes/` — API 路由 (accounting/tax/auth)
- `middleware/` — 认证 · 角色 · 多租户
- `config/database.js` — mysql2 连接池 + AsyncLocalStorage
- `public/accounting_index.html` — Vue 2.7 SPA 前端

## 提交规范

- feat: 新功能
- fix: Bug 修复
- docs: 文档
- refactor: 重构
- perf: 性能优化

## 代码风格

- 2空格缩进
- 单引号字符串
- async/await 异步处理
- 参数化 SQL 查询 (防注入)
