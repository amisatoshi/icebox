# 6. Send bitcoin

[← Receive](05-receive.md) · [Contents](README.md) · Next: [Restore a wallet →](07-restore.md)

Sending needs as many devices as the wallet's threshold, e.g. **2** for "2 to sign". You can
plug them in all together, or one after another.

Open the wallet and click the **Send** tab (or **Wallet → Send**, **Ctrl+S** / **⌘S**).

## 1. Enter the payment

![A new payment with fee suggestions](img/11-send-form.png)

- **Pay to:** the address, or a `bitcoin:` payment link (Icebox keeps just the address).
  Mainnet addresses start `bc1…`; Signet and Testnet ones start `tb1…`. Or click **📷 Scan** to
  read the payee's QR code with your webcam; if it includes an amount, that's filled in too.
- **Amount (sats):** 1 bitcoin = 100,000,000 sats. Or tick **Send everything** to empty the
  wallet (the fee comes out of the amount). The minimum for the address you entered is shown
  underneath.
- **Fee rate (sat/vB):** click **Suggest fee rates** for current estimates (next block, ~30 min,
  ~1 hour, ~4 hours) and pick one. Higher pays more and confirms sooner.
- **Note (optional):** a label for this payment, e.g. "Supplier invoice 1042". It stays on this
  computer and isn't sent with the payment. See [Labels](13-labels-coins-and-exports.md#labels).

With [prices](10-settings.md#prices) switched on, the amount's value in your currency shows under
it, and on the review screen.

Click **Review payment**.

> Very small amounts ("dust": under 330 sats for most addresses, 546 for older ones starting
> `1`) can't be sent. Icebox shows the minimum and stops you before signing.

**About the webcam:** the camera is only on while the scan window is open, and images are read on
your computer and never stored or sent anywhere. macOS asks permission the first time. On Linux,
Icebox can't use the camera yet: paste the address instead.

## 2. Review and choose the signers

![Review the payment and choose which devices sign](img/12-send-review.png)

Check **To**, **Amount**, **Network fee**, and **Change back to this wallet**.

Under **Sign with 2 devices**, tick exactly as many devices as the threshold. Icebox pre-ticks
the ones already plugged in. Click **Edit** to change the payment, or **Start signing**.

## 3. Sign on each device

![Signing: one device has signed, the other is ready](img/13-send-signing.png)

For each device:

1. Plug it in (if it isn't already) and click **Ask to sign**.
2. The device shows the payment. **Check the address and amount on the device's screen**, not
   just on the computer.
3. Approve on the device. Its line turns to **signed**.

If the device screen shows a different address or amount from what you meant to send,
**don't approve it**. Cancel the payment, and treat that computer as untrusted.

## 4. Broadcast

![Both devices have signed](img/14-send-signed.png)

When every device has signed, click **Broadcast payment**. Icebox sends it to the network,
shows "Sent", and switches to **History**, where it appears as **pending** until it's mined.
Click the transaction ID to follow it on mempool.space.

## Pausing, continuing and cancelling

You don't have to finish in one go. Click **Pause** (or **Close** once it's signed) and the
payment waits under **Payments in progress**, even if you quit Icebox:

![A fully signed payment waiting under Payments in progress](img/15-send-in-progress.png)

- **Continue signing:** pick up where you left off, e.g. when the next device is with you.
- **Broadcast:** for a payment that's already fully signed.
- **Cancel → Yes, cancel payment:** throws the payment away. Nothing was sent, and the coins stay
  in the wallet. You can cancel a fully signed payment too, as long as you haven't broadcast it.

## If broadcasting fails

Icebox explains the most common reasons:

| Message | What to do |
|---------|------------|
| An amount is too small ("dust") | Cancel it under Payments in progress and send a larger amount. |
| The fee rate is too low right now | Cancel it and send again with a higher fee rate. |
| Some of its coins were already spent | Another payment used the same coins. Cancel it and send again. |

Any other error is shown as "Broadcast failed: …". Check your connection in
[Settings](10-settings.md) and try again.

## Not yet in Icebox

Speeding up a stuck payment (RBF/CPFP), choosing which coins pay someone (you can already
[combine chosen coins](13-labels-coins-and-exports.md#combine-coins)), and PSBT import/export
aren't in Icebox yet; PSBT is on the [roadmap](../../ROADMAP.md). For now, use the official
Frostsnap app for those.

A payment that's been waiting for over two weeks is marked **may never confirm** in History: the
network has probably dropped it, usually because its fee was too low.

[← Receive](05-receive.md) · [Contents](README.md) · Next: [Restore a wallet →](07-restore.md)
