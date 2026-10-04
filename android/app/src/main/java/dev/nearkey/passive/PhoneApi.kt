package dev.nearkey.passive

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.UnknownServiceException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

/** Platform TLS verification remains enabled; redirects cannot forward the phone token. */
class PhoneApi(context: Context) {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()

    private var socket: WebSocket? = null
    private var closed = false
    private var wifiNetwork: Network? = null
    private var wifiClient: OkHttpClient? = null

    @Suppress("DEPRECATION")
    private fun clientFor(base: HttpUrl): OkHttpClient {
        if (!LocalNetwork.isPrivateIpv4(base.host)) return client
        // A local Wi-Fi network can work even when Android chooses cellular for internet access.
        // Bind just this client's sockets, leaving other websites and the process default intact.
        val networks = connectivity.allNetworks.filter {
            val capabilities = connectivity.getNetworkCapabilities(it)
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
        }
        val network = networks.firstOrNull { it == connectivity.activeNetwork } ?: networks.firstOrNull()
        require(network != null) { LocalNetwork.WIFI_REQUIRED }
        if (wifiNetwork != network) {
            wifiClient = client.newBuilder().socketFactory(network.socketFactory)
                .dns(object : Dns {
                    override fun lookup(hostname: String): List<InetAddress> = network.getAllByName(hostname).toList()
                }).build()
            wifiNetwork = network
        }
        return wifiClient!!
    }

    fun origin(value: String): HttpUrl = PhoneOrigin.parse(value)

    @Synchronized
    fun post(origin: HttpUrl, path: String, body: JSONObject, token: String? = null,
        done: (JSONObject?, String?) -> Unit): Call {
        check(!closed) { "Phone connection has been closed" }
        val base = this.origin(origin.toString())
        val target = base.resolve(path)
        require(path.startsWith("/") && target != null && target.scheme == base.scheme &&
            target.host == base.host && target.port == base.port && target.username.isEmpty() &&
            target.password.isEmpty() && target.query == null && target.fragment == null) {
            "Phone requests must use a path on the configured server origin"
        }
        val request = Request.Builder().url(target)
            .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
        if (token != null) {
            require(token.isNotEmpty() && token.length <= 1024 && token.all { it.code in 33..126 }) {
                "Invalid phone credential"
            }
            request.header("Authorization", "Bearer $token")
        }
        return clientFor(base).newCall(request.build()).also { call ->
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    val error = when {
                        call.isCanceled() -> "Request cancelled"
                        e is SSLException -> "HTTPS connection failed; check the server certificate and device trust"
                        e is UnknownServiceException && !base.isHttps ->
                            "Cleartext HTTP is unavailable; use HTTPS or a debug build"
                        !base.isHttps && base.host in setOf("localhost", "127.0.0.1", "::1") ->
                            "Cannot reach the computer's local server. Check USB forwarding, or scan a Wi-Fi setup QR from your computer with both devices on the same Wi-Fi network."
                        LocalNetwork.isPrivateIpv4(base.host) -> LocalNetwork.UNREACHABLE
                        else -> "Network request failed; check URL and connectivity"
                    }
                    done(null, error)
                }
                override fun onResponse(call: Call, response: Response) {
                    val result: Pair<JSONObject?, String?> = try {
                        response.use {
                            if (!it.isSuccessful) {
                                val errorBody = try { responseBytes(it) } catch (_: Exception) { null }
                                null to PhoneErrors.response(it.code, errorBody)
                            } else {
                                JSONObject(Protocol.utf8(responseBytes(it))) to null
                            }
                        }
                    } catch (_: IOException) {
                        null to "Network response interrupted; check connectivity"
                    } catch (_: Exception) {
                        null to "Invalid server response"
                    }
                    // Release the response before invoking application code, and never retry a callback
                    // if application code itself throws.
                    if (call.isCanceled()) done(null, "Request cancelled")
                    else done(result.first, result.second)
                }
            })
        }
    }

    private fun responseBytes(response: Response): ByteArray {
        val output = ByteArrayOutputStream()
        val input = response.body?.byteStream() ?: error("Empty response")
        val chunk = ByteArray(1024)
        while (true) {
            val count = input.read(chunk)
            if (count < 0) break
            require(output.size() + count <= 8192) { "Response too large" }
            output.write(chunk, 0, count)
        }
        return output.toByteArray()
    }

    @Synchronized
    fun channel(origin: HttpUrl, token: String, listener: WebSocketListener): WebSocket {
        check(!closed) { "Phone connection has been closed" }
        val base = this.origin(origin.toString())
        require(token.isNotEmpty() && token.length <= 1024 && token.all { it.code in 33..126 }) {
            "Invalid phone credential"
        }
        val request = Request.Builder().url(base.resolve("/api/phone-channel")!!)
            // OkHttp upgrades HTTPS as WSS and debug HTTP as WS. Never put the credential in a URL.
            .header("Authorization", "Bearer $token").build()
        socket?.cancel()
        return clientFor(base).newWebSocket(request, listener).also { socket = it }
    }

    @Synchronized
    fun cancelRequests() {
        // Dispatcher cancellation alone does not close an already-upgraded WebSocket.
        socket?.cancel()
        socket = null
        client.dispatcher.cancelAll()
    }

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        cancelRequests()
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }
}
