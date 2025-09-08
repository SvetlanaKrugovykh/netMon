
# NetMon - Network Monitoring Service

Network monitoring service with support for SNMP, MRTG, ping checks, and report generation.

## Features

- ✅ SNMP device monitoring
- ✅ MRTG traffic data collection
- ✅ Ping host monitoring
- ✅ Graphical report generation
- ✅ Report delivery to Telegram
- ✅ PostgreSQL for data storage

## Installation

```bash
# Install dependencies
npm install

# Configure .env file
cp .env.example .env
# Edit database connection parameters

# Start the service
npm start

# Or run in development mode
npm run dev
```

## Configuration

Main settings in `.env`:

- `TRAFFIC_DB_HOST` - PostgreSQL server IP
- `SNMP_MRTG_POOLING_INTERVAL` - MRTG polling interval (seconds)
- `TELEGRAM_BOT_TOKEN_SILVER` - Telegram bot token
- `IP_NET_WATCH_INTERVAL` - ping monitoring interval (seconds)

## Structure


```
src/
├── server/
│   ├── app.js              # main server
│   ├── db/                 # database operations
│   ├── services/           # monitoring services
│   ├── reports/            # report generation
│   └── utils/              # utilities
└── templates/              # report templates
```

## Deployment on Ubuntu Server

```bash
# Install Node.js and dependencies
sudo apt install -y nodejs npm build-essential libcairo2-dev libpango1.0-dev

# Clone the project
cd /opt && git clone <repo>

# Install packages
npm install

# Configure .env and start
npm start
```
