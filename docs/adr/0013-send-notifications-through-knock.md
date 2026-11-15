# Send Notifications through Knock, within its free plan

Cadence sends every Notification through Knock, a hosted vendor, which also holds the Notification Feed and each person's preferences. Knock was the only vendor we compared whose free plan has what production needs: feed access only through user tokens our server signs, a headless feed API to build our own Notification Feed on, and preferences by category and channel. v1 must stay within the free plan's 10,000 messages a month. A message is one recipient on one channel, and Notification Feed messages count, so every channel a Notification goes out on adds to the total.

## Considered Options

- **MagicBell.** Sends web push itself, but its free plan stops at 1,000 deliveries a month, then $249 a month.
- **Courier.** The runner-up: pay-as-you-go at $0.005 a send, with no price jump, but web push needs FCM or OneSignal too.
- **Novu Cloud.** The cheapest paid plan, but feed auth is a static HMAC that never expires, and preferences have no categories.
- **SuprSend.** Vendor-stored preferences aren't on its free plan, and category preferences need its $250 a month plan.

## Consequences

- Web push, if it is ever added, goes through Firebase Cloud Messaging: a second service, the Firebase SDK and a service worker.
- Past 10,000 messages a month the next plan is $250 a month. Knock does not stop sending at the limit, so going over shows up as a bill, not an outage.
