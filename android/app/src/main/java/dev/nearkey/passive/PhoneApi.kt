package dev.nearkey.passive

import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import java.util.concurrent.TimeUnit

/** Platform TLS verification remains enabled; redirects cannot forward the phone token. */
class PhoneApi {
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()

    fun origin(value: String): HttpUrl {
        val url = value.trim().toHttpUrl()
        require(url.isHttps || (BuildConfig.DEBUG && url.scheme == "http")) { "Release requires HTTPS" }
        require(url.username.isEmpty() && url.password.isEmpty() && url.query == null &&
            url.fragment == null && url.encodedPath == "/") { "Enter a server origin only, without path or credentials" }
        return url
    }

    fun post(origin: HttpUrl, path: String, body: JSONObject, token: String? = null,
        done: (JSONObject?, String?) -> Unit): Call {
        val request = Request.Builder().url(origin.resolve(path)!!)
            .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
        if (token != null) request.header("Authorization", "Bearer $token")
        return client.newCall(request.build()).also { call ->
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { done(null, "Network request failed; check URL and connectivity") }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        if (!it.isSuccessful) {
                            // Avoid echoing response bodies or credentials into the UI/logs.
                            done(null, "Server rejected request (HTTP ${it.code})")
                            return
                        }
                        try {
                            val output = ByteArrayOutputStream()
                            val input = it.body?.byteStream() ?: error("Empty response")
                            val chunk = ByteArray(1024)
                            while (true) {
                                val count = input.read(chunk)
                                if (count < 0) break
                                require(output.size() + count <= 8192) { "Response too large" }
                                output.write(chunk, 0, count)
                            }
                            done(JSONObject(Protocol.utf8(output.toByteArray())), null)
                        } catch (_: Exception) { done(null, "Invalid server response") }
                    }
                }
            })
        }
    }

    fun channel(origin: HttpUrl, token: String, listener: WebSocketListener): WebSocket =
        client.newWebSocket(Request.Builder().url(origin.resolve("/api/phone-channel")!!)
            .header("Authorization", "Bearer $token").build(), listener)

    fun cancelRequests() { client.dispatcher.cancelAll() }
    fun close() { cancelRequests(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
}
