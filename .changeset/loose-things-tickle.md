---
"scrubjay": minor
---

Add RSS feed subscription and alerting system

- Add RSS feed ingestion with automatic fetching every 5 minutes
- Add RSS dispatcher service to send RSS alerts to Discord channels
- Add database schema for RSS sources, items, and channel subscriptions
- Integrate RSS dispatcher into the dispatch job alongside eBird alerts
- Add RSS service, repository, fetcher, and transformer for feed processing
