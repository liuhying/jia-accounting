# 🏠 家记账 (Jia Accounting)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![MySQL](https://img.shields.io/badge/mysql-%3E%3D8.0-orange.svg)](https://mysql.com)

**开源企业级会计系统** — 凭证 · 账簿 · 报表 · 税务 · 固定资产 · 存货 · 往来 · 对账

> 单体 SPA + Express REST API，中小企业记账一站式解决方案

---

## 📊 功能全景

| 模块 | 功能 |
|------|------|
| 📝 **凭证管理** | 记账/收款/付款/转账四类凭证，审核→过账→冲销全流程 |
| 🏷️ **科目体系** | 61个标准科目（企业会计准则），4级编码，辅助核算 |
| 📊 **财务报表** | 试算平衡表 · 资产负债表(流动/非流动) · **13层多步式利润表** · 现金流量表 |
| 🏛️ **税务看板** | 增值税 · 企业所得税 · 附加税，**实时从凭证计算** |
| 🏢 **固定资产** | 台账管理 · 折旧记录 · 残值/月折旧额 |
| 📦 **存货管理** | 收发存汇总 · 加权平均成本 · 库存流水 |
| 💰 **应收应付** | 账龄分析 (6段:1-30/31-60/61-90/91-180/181-365/365+) |
| 🏦 **银行对账** | CSV导入 · 自动匹配 · 手工核销 |
| 📅 **期末结转** | 自动损益结转 · 反结账 · 结账状态 |
| 🔐 **权限管理** | RBAC 4角色 (super_admin/admin/accountant/viewer) |
| 🗂️ **多账套** | 27表 AsyncLocalStorage 自动隔离，一套部署多公司使用 |
| 🌍 **多币种** | CNY/USD/EUR/JPY 汇率管理 |
| 📋 **审计日志** | 全操作记录，可追溯 |

---

## 🏗️ 技术架构
```
┌──────────────────────────────────────────────┐
│         Nginx (reverse proxy)                │
├──────────────────────────────────────────────┤
│ accounting_index.html (Vue 2.7 SPA)          │
│ · 单文件 14个Tab零跳转                        │
│ · Element UI + Axios                         │
├──────────────────────────────────────────────┤
│ Express.js API Server (port 3000)            │
│  ├─ routes/accounting.js  (114 routes)       │
│  ├─ routes/tax.js                            │
│  ├─ routes/auth.js  (JWT)                    │
│  ├─ middleware/auth.js                       │
│  ├─ middleware/roles.js  (RBAC)               │
│  ├─ middleware/accountSet.js (多租户)         │
│  └─ config/database.js (mysql2)              │
├──────────────────────────────────────────────┤
│ MySQL 8.0 (27 accounting tables)             │
└──────────────────────────────────────────────┘
```

**核心设计亮点**:
- **AsyncLocalStorage 多租户**: 一次数据库查询自动注入 `account_set_id`，上层代码无需感知多账套
- **实时税务计算**: 不依赖预计算表，直接从 `acc_voucher_entries` + `acc_subjects` 实时聚合
- **13层多步式利润表**: 营收→成本→税金→费用→营业利润→营业外→利润总额→所得税→净利润
- **v-show 大规模模板**: 14个面板全用 v-show，避免 Vue 2.7 大模板 v-if 编译异常

---

## 🚀 快速开始
### 前提条件

- Node.js >= 18
- MySQL >= 8.0
- (可选) Nginx

### Docker 一键部署 (推荐)

```bash
git clone https://github.com/liuhying/jia-accounting.git
cd jia-accounting

# 启动
docker-compose up -d

# 访问 http://localhost:3000/accounting/
# 默认账号: admin / admin123
```

### 手动部署

```bash
# 1. 创建数据库
mysql -u root -e "CREATE DATABASE jia_app DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci"

# 2. 导入表结构
mysql -u root jia_app < sql/01_basic.sql
mysql -u root jia_app < sql/02_accounting.sql
mysql -u root jia_app < sql/03_aux.sql
mysql -u root jia_app < sql/04_tax.sql

# 3. 配置环境
cp .env.example .env
# 编辑 .env ，修改 DB_PASSWORD 和 JWT_SECRET

# 4. 安装依赖 + 启动
npm install
npm start

# 5. 访问
# 主应用: http://localhost:3000/accounting/
# API: http://localhost:3000/api/auth/login
```

### Nginx 配置示例

```nginx
server {
    listen 80;
    root /var/www/jia_app/public;
    
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    location /accounting/ {
        alias /var/www/jia_app/public/;
        index accounting_index.html;
        try_files $uri $uri/ /accounting_index.html;
    }
}
```

---

## 📡 API 概览 (114 endpoints)

### 认证
| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/login` | - |
| GET | `/api/auth/me` | JWT |

### 凭证
| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/accounting/vouchers` | 凭证列表 (支持search/status/page) |
| GET | `/api/accounting/vouchers/:id` | 凭证详情 (含分录/辅助核算) |
| POST | `/api/accounting/vouchers` | 新建凭证 |
| POST | `/api/accounting/vouchers/:id/post` | 过账 |
| POST | `/api/accounting/vouchers/:id/reverse` | 冲销 |

### 财务报表
| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/accounting/statements/trial-balance` | 试算平衡表 |
| GET | `/api/accounting/statements/balance-sheet` | 资产负债表 |
| GET | `/api/accounting/statements/income-statement` | 利润表 |
| GET | `/api/accounting/statements/cash-flow` | 现金流量表 |
| GET | `/api/accounting/statements/financial-report` | 综合财务报告 |

### 税务
| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/tax/summary` | 税务汇总 |
| GET | `/api/tax/vat` | 增值税明细 |
| GET | `/api/tax/cit` | 企业所得税 |
| GET | `/api/tax/surtax` | 附加税 |

### 其余模块
`/api/accounting/subjects` · `subjects/tree` · `fixed-assets` · `inventory-items` · `inventory/balance` · `arap/summary` · `arap/aging` · `bank-statements` · `bank-statements/upload` · `bank-statements/:id/auto-reconcile` · `period-close/status` · `period-close` · `accounts` · `currencies` · `ledger/*` · `export` · `account-sets` · `auxiliary/*` · `summary`

---

## 🧪 测试

全链路 44 项 API 测试全部通过:
```
AUTH  5/5  ✅ | CORE    2/2  ✅ | VOUCHER 3/3  ✅
SUBJECT 2/2 ✅ | REPORT  6/6  ✅ | ARAP    4/4  ✅
BANKREC 4/4 ✅ | TAX     5/5  ✅ | FA      2/2  ✅
INVENTORY 3/3 ✅ | PERIOD 2/2 ✅ | ACCOUNT 2/2 ✅
AUX   1/1  ✅ | EDGE    3/3  ✅
────────────────────────────────────────────
总计: 44/44 (100%) | avg: 14ms | p50: 10ms
```

---

## 📂 目录结构

```
jia-accounting/
├── app.js                    # 入口
├── package.json
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── config/
│   └── database.js           # mysql2 + AsyncLocalStorage 多租户
├── middleware/
│   ├── auth.js               # JWT 认证
│   ├── roles.js              # RBAC 角色中间件
│   └── accountSet.js         # 账套上下文注入
├── routes/
│   ├── accounting.js         # 核心会计路由 (114 endpoints)
│   ├── tax.js                # 税务路由
│   └── auth.js               # 认证路由
├── utils/
│   └── response.js           # 统一响应格式
├── sql/
│   ├── 01_basic.sql          # 基础表
│   ├── 02_accounting.sql     # 会计核心表 (27表)
│   ├── 03_aux.sql            # 辅助核算
│   └── 04_tax.sql            # 税务
└── public/
    ├── accounting_index.html # Vue 2.7 SPA 主应用
    ├── vue.min.js
    ├── axios.min.js
    ├── element-ui.css
    └── element-ui-index.js
```

---

## 🔒 安全

- JWT 认证 (30天过期)
- RBAC 四级权限 (super_admin > admin > accountant > viewer)
- 所有写操作 requireRole 中间件保护
- 参数化 SQL 查询 (防注入)
- 多账套数据隔离 (account_set_id)

---

## 🌟 vs 竞品

| | 金蝶精斗云 | 用友好会计 | **家记账** |
|------|:--:|:--:|:--:|
| 年费 | ¥798-1498 | ¥498-998 | **¥0** |
| 利润表层级 | 5-7 | 5-7 | **13** |
| 税务计算 | 预计算 | 预计算 | **实时** |
| 数据自主权 | ❌ | ❌ | **✅** |
| 定制开发 | ❌ | ❌ | **✅** |
| 源码开放 | ❌ | ❌ | **✅** |

---

## 📄 License

MIT — 自由使用、修改、分发，详见 [LICENSE](LICENSE)

---

## 🤝 贡献

欢迎 Issue / PR！
```bash
git clone https://github.com/liuhying/jia-accounting.git
cd jia-accounting
npm install
# 开发模式
node app.js
```

---

*Built with ❤️ for Chinese small businesses*
