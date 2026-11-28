package uk.co.blockchainology.icebox.usb

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.ParcelFileDescriptor
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class OpenArgs {
    lateinit var id: String
}

/**
 * Lists Frostsnap devices on the phone's USB port, asks permission for new ones, and opens them
 * so Rust gets a file descriptor. Rust then drives the device with frostsnap_coordinator's own
 * CDC-ACM code, as the official Frostsnap Android app does (see its CdcAcmPlugin.kt).
 */
@TauriPlugin
class IceboxUsbPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        // Frostsnap devices (ESP32-C3 USB serial/JTAG): 0x303a:0x1001
        const val FROSTSNAP_VID = 12346
        const val FROSTSNAP_PID = 4097
        const val ACTION_USB_PERMISSION = "uk.co.blockchainology.icebox.USB_PERMISSION"
    }

    private val usbManager: UsbManager
        get() = activity.getSystemService(Context.USB_SERVICE) as UsbManager

    // Devices we've already asked about this session, so the prompt isn't repeated every poll.
    private val asked = mutableSetOf<String>()

    private fun isFrostsnap(d: UsbDevice) = d.vendorId == FROSTSNAP_VID && d.productId == FROSTSNAP_PID

    private fun askPermission(d: UsbDevice) {
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(activity.packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pending = PendingIntent.getBroadcast(activity, 0, intent, flags)
        usbManager.requestPermission(d, pending)
    }

    @Command
    fun listDevices(invoke: Invoke) {
        val list = JSArray()
        val present = mutableSetOf<String>()
        for (d in usbManager.deviceList.values) {
            if (!isFrostsnap(d)) continue
            present.add(d.deviceName)
            val permitted = usbManager.hasPermission(d)
            if (!permitted && asked.add(d.deviceName)) {
                Logger.info("IceboxUsb", "asking permission for ${d.deviceName}")
                askPermission(d)
            }
            val o = JSObject()
            o.put("id", d.deviceName)
            o.put("vid", d.vendorId)
            o.put("pid", d.productId)
            o.put("permitted", permitted)
            list.put(o)
        }
        // Unplugged devices can be asked about again when they come back.
        asked.retainAll(present)
        val ret = JSObject()
        ret.put("devices", list)
        invoke.resolve(ret)
    }

    @Command
    fun openDevice(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val device = usbManager.deviceList.values.firstOrNull { it.deviceName == args.id }
        if (device == null) {
            invoke.reject("USB device ${args.id} isn't plugged in"); return
        }
        if (!usbManager.hasPermission(device)) {
            invoke.reject("Icebox isn't allowed to use ${args.id} yet"); return
        }
        // Off the main thread: the official app waits 1.5 s before opening, which stopped device
        // screens staying off after a reset or replug.
        Thread {
            try {
                Thread.sleep(1500)
                val connection = usbManager.openDevice(device)
                if (connection == null) {
                    invoke.reject("Android couldn't open ${args.id}"); return@Thread
                }
                val fd = connection.fileDescriptor
                if (fd < 0) {
                    connection.close(); invoke.reject("Android gave no file descriptor for ${args.id}"); return@Thread
                }
                // Give Rust its own copy, then close Android's connection (only its fd closes).
                val dup = ParcelFileDescriptor.fromFd(fd).detachFd()
                connection.close()
                val ret = JSObject()
                ret.put("fd", dup)
                invoke.resolve(ret)
            } catch (e: Exception) {
                Logger.error("IceboxUsb", "opening ${args.id} failed: ${e.message}", e)
                invoke.reject(e.message ?: "opening ${args.id} failed")
            }
        }.start()
    }
}
