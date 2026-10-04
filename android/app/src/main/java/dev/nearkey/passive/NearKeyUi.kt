package dev.nearkey.passive

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.InputType
import android.text.TextWatcher
import android.text.Editable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Native, density-aware screens; the bottom-left add action stays above system navigation. */
class NearKeyUi(private val context: Context) {
    private val ink = Color.rgb(25, 29, 48)
    private val muted = Color.rgb(105, 111, 132)
    private val violet = Color.rgb(106, 83, 220)
    private val pale = Color.rgb(239, 235, 255)
    private val pageColor = Color.rgb(247, 248, 252)
    val root = FrameLayout(context).apply { setBackgroundColor(pageColor) }
    private lateinit var content: LinearLayout
    private var statusLabel: TextView? = null
    private var loginLabel: TextView? = null
    private val connectionLabels = mutableMapOf<String, TextView>()

    init {
        if (Build.VERSION.SDK_INT >= 29) root.isForceDarkAllowed = false
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
    }

    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
    private fun rounded(color: Int, radius: Int = 22, stroke: Int? = null) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
        stroke?.let { setStroke(dp(1), it) }
    }
    private fun column() = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun label(value: String, size: Float = 16f, color: Int = ink, bold: Boolean = false) = TextView(context).apply {
        text = value; textSize = size; setTextColor(color)
        typeface = Typeface.create(if (bold) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
        setLineSpacing(dp(3).toFloat(), 1f)
    }
    private fun LinearLayout.space(height: Int) { addView(View(context), LinearLayout.LayoutParams(1, dp(height))) }
    private fun LinearLayout.copy(value: String, size: Float = 16f, color: Int = muted, bold: Boolean = false): TextView =
        label(value, size, color, bold).also { addView(it) }
    private fun button(value: String, secondary: Boolean = false, action: () -> Unit): Button = Button(context).apply {
        text = value; textSize = 16f; isAllCaps = false
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(if (secondary) violet else Color.WHITE)
        background = rounded(if (secondary) pale else violet, 16)
        backgroundTintList = ColorStateList.valueOf(if (secondary) pale else violet)
        stateListAnimator = null
        minHeight = dp(56); minimumHeight = dp(56)
        setPadding(dp(16), dp(8), dp(16), dp(8))
        setOnClickListener { action() }
    }
    private fun LinearLayout.action(value: String, enabled: Boolean = true, secondary: Boolean = false, action: () -> Unit) {
        addView(button(value, secondary, action).apply { isEnabled = enabled; alpha = if (enabled) 1f else .45f },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    private fun prepare(extraBottom: Int = 28) {
        root.removeAllViews(); connectionLabels.clear(); statusLabel = null; loginLabel = null
        content = column().apply { setPadding(dp(24), dp(18), dp(24), dp(extraBottom)) }
        root.addView(ScrollView(context).apply {
            isFillViewport = true; clipToPadding = false; addView(content)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }
    fun wizard(step: Int, origin: String, code: String, manual: Boolean, loaded: Boolean,
        busy: Boolean, available: Boolean, status: String, canClose: Boolean,
        start: () -> Unit, importKeys: () -> Unit, scan: () -> Unit, toggleManual: () -> Unit, enroll: () -> Unit,
        bluetooth: () -> Unit, back: () -> Unit, retry: () -> Unit,
        edit: (String, String) -> Unit) {
        prepare()
        content.addView(row().apply {
            background = rounded(pale, 16)
            setPadding(dp(8), dp(4), dp(8), dp(4))
            listOf("Start", "Website", "Bluetooth").forEachIndexed { index, title ->
                addView(label("${if (index + 1 < step) "✓" else "${index + 1}"}  $title", 12f,
                    if (index + 1 <= step) violet else muted, true).apply {
                    gravity = Gravity.CENTER; setPadding(dp(4), dp(12), dp(4), dp(12))
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            }
        })
        if (step != 1) content.space(30)
        when (step) {
            1 -> {
                content.space(30)
                content.copy("Pair a new provider", 34f, ink, true).apply {
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                }
                content.addView(FrameLayout(context).apply {
                    minimumHeight = dp(253)
                    addView(SetupArtwork(context), FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, dp(205), Gravity.CENTER))
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                statusLabel = content.copy(status, 14f).apply {
                    setPadding(0, 0, 0, dp(18))
                    visibility = if (status.isBlank()) View.GONE else View.VISIBLE
                    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
                }
                info("01", "Connect a website")
                content.space(12)
                info("02", "Keep your phone nearby")
                content.space(28)
                content.action("Import keys", available, secondary = true, action = importKeys)
                content.space(12)
                content.action("Get started", available, action = start)
            }
            2 -> {
                content.copy(if (loaded) "Connect a website." else "Connect your\nfirst website.".let {
                    if (canClose) "Connect a\nwebsite." else it
                }, 34f, ink, true)
                content.space(12)
                content.copy(if (loaded) "Check the website address below, then securely connect this phone." else
                    "Open NearKey setup on your computer and scan the QR code to pair this phone.", 16f)
                val websiteCard = if (loaded && !manual) {
                    column().apply {
                        setPadding(dp(22), dp(24), dp(22), dp(24)); background = rounded(Color.WHITE)
                        copy("WEBSITE TO CONNECT", 11f, violet, true); space(12)
                        copy(try { PhoneOrigin.parse(origin).host } catch (_: Exception) { origin }, 23f, ink, true)
                        space(6); copy(origin, 14f); space(16)
                        copy("Only continue if you recognize this address.", 13f)
                    }
                } else {
                    column().apply {
                        gravity = Gravity.CENTER; setPadding(dp(24), dp(26), dp(24), dp(26))
                        background = rounded(Color.WHITE, 24)
                        addView(SetupArtwork(context, qrOnly = true), LinearLayout.LayoutParams(dp(116), dp(116)))
                    }
                }
                content.addView(FrameLayout(context).apply {
                    setPadding(0, dp(24), 0, dp(24))
                    addView(websiteCard, FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                statusLabel = content.copy(status, 14f).apply {
                    setPadding(0, 0, 0, dp(18))
                    visibility = if (status.isBlank()) View.GONE else View.VISIBLE
                    accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
                }
                if (!loaded) {
                    content.action("Scan setup QR code", available && !busy, action = scan)
                    content.space(12)
                }
                if (manual) {
                    val fields = column()
                    val address = input("Website server address", origin, false)
                    val pairing = input("Pairing code", code, true)
                    fields.copy("Website server address", 13f, ink, true); fields.space(8); fields.addView(address)
                    fields.space(16); fields.copy("Pairing code", 13f, ink, true); fields.space(8); fields.addView(pairing)
                    val watcher = object : TextWatcher {
                        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                        override fun afterTextChanged(s: Editable?) { edit(address.text.toString(), pairing.text.toString()) }
                    }
                    address.addTextChangedListener(watcher); pairing.addTextChangedListener(watcher)
                    address.isEnabled = !busy; pairing.isEnabled = !busy
                    content.addView(fields); content.space(20)
                }
                if (loaded || manual) {
                    content.action(if (busy) "Connecting website…" else "Connect website", available && !busy, action = enroll)
                    content.space(12)
                }
                if (!loaded) {
                    content.action(if (manual) "Hide manual details" else "Enter details manually", available && !busy, true, toggleManual)
                    content.space(14)
                }
                content.action("Back", available && !busy, true, back)
            }
            3 -> {
                content.copy("One last\nconnection.", 36f, ink, true)
                content.space(12)
                content.copy("Your website is paired. Enable Bluetooth so your browser can find this phone.", 17f)
                content.space(26)
                info("1", "Allow Nearby devices", "Tap below and allow Bluetooth access when prompted.")
                content.space(12)
                info("2", "Choose this phone", "Select your phone in the computer’s Bluetooth chooser, then continue in the browser.")
                content.space(24)
                content.action("Connect Bluetooth & finish", available, action = bluetooth)
                content.space(12)
                content.action("Retry website connection", available, true, retry)
            }
        }
        if (step == 3) {
            content.space(18)
            statusLabel = content.copy(status, 14f).apply {
                visibility = if (status.isBlank()) View.GONE else View.VISIBLE
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            }
        }
    }

    private fun input(hintText: String, value: String, secret: Boolean) = EditText(context).apply {
        hint = hintText; setText(value); textSize = 16f; setTextColor(ink); setHintTextColor(muted)
        inputType = InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_URI
        setSingleLine(true); isSaveEnabled = false
        setPadding(dp(16), dp(16), dp(16), dp(16)); background = rounded(Color.WHITE, 14, Color.rgb(222, 224, 236))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun info(number: String, title: String, description: String? = null) {
        content.addView(row().apply {
            gravity = if (description == null) Gravity.CENTER_VERTICAL else Gravity.TOP
            background = rounded(Color.WHITE, 20); setPadding(dp(18), dp(20), dp(18), dp(20))
            addView(label(number, 15f, violet, true).apply { gravity = Gravity.CENTER; background = rounded(pale, 12) },
                LinearLayout.LayoutParams(dp(36), dp(36)))
            addView(column().apply {
                setPadding(dp(14), 0, 0, 0); copy(title, 16f, ink, true)
                description?.let { space(5); copy(it, 14f) }
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        })
    }

    fun websites(sites: List<ConnectedWebsite>, statuses: Map<String, Pair<Boolean, String>>,
        login: String, message: String, add: () -> Unit, details: (ConnectedWebsite) -> Unit) {
        prepare(122)
        content.copy("Your websites", 34f, ink, true); content.space(10)
        content.copy("${sites.size} connected ${if (sites.size == 1) "website" else "websites"}. One key, always with you.", 16f)
        content.space(26)
        loginLabel = content.copy(login, 14f, violet, true).apply {
            background = rounded(pale, 16); setPadding(dp(18), dp(16), dp(18), dp(16))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        content.space(26)
        content.copy("CONNECTED WEBSITES", 11f, muted, true); content.space(14)
        sites.forEach { site ->
            content.addView(row().apply {
                background = rounded(Color.WHITE, 22); setPadding(dp(18), dp(20), dp(16), dp(20))
                isClickable = true; isFocusable = true
                contentDescription = "${site.address}. Website connection details"
                setOnClickListener { details(site) }
                addView(label(site.address.first().uppercase(), 23f, violet, true).apply {
                    gravity = Gravity.CENTER; background = rounded(pale, 16)
                }, LinearLayout.LayoutParams(dp(52), dp(52)))
                addView(column().apply {
                    setPadding(dp(16), 0, dp(8), 0); copy(site.address, 17f, ink, true); space(5)
                    connectionLabels[site.origin] = copy("", 13f)
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(label("›", 27f, muted))
            })
            content.space(12)
        }
        content.space(12)
        content.copy("Keep NearKey open and Bluetooth on. Your phone verifies website logins automatically.", 14f)
        content.space(16)
        statusLabel = content.copy(message, 13f)
        root.addView(row().apply {
            setPadding(dp(24), dp(14), dp(24), dp(20)); setBackgroundColor(pageColor)
            addView(button("+", action = add).apply {
                textSize = 32f; contentDescription = "Connect another website"
                background = rounded(violet, 30); elevation = dp(5).toFloat()
            }, LinearLayout.LayoutParams(dp(60), dp(60)))
            addView(label("Connect a website", 15f, ink, true).apply { setPadding(dp(16), 0, 0, 0) })
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START))
        updateConnections(statuses)
    }

    fun updateStatus(message: String) {
        statusLabel?.apply {
            text = message
            visibility = if (message.isBlank()) View.GONE else View.VISIBLE
        }
    }
    fun updateLogin(value: String) { if (loginLabel?.text?.toString() != value) loginLabel?.text = value }
    fun updateConnections(statuses: Map<String, Pair<Boolean, String>>) {
        connectionLabels.forEach { (origin, label) ->
            val state = statuses[origin]
            label.text = if (state?.first == true) "●  Connected" else state?.second ?: "Offline"
            label.setTextColor(if (state?.first == true) Color.rgb(37, 132, 104) else muted)
        }
    }
}

/** Small locally drawn illustration, with no remote assets or enrollment data. */
private class SetupArtwork @JvmOverloads constructor(context: Context, private val qrOnly: Boolean = false) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val scale = minOf(width / (if (qrOnly) 116f else 310f), height / (if (qrOnly) 116f else 205f))
        canvas.save(); canvas.translate((width - scale * if (qrOnly) 116 else 310) / 2f,
            (height - scale * if (qrOnly) 116 else 205) / 2f); canvas.scale(scale, scale)
        fun rect(x: Float, y: Float, w: Float, h: Float, radius: Float, color: String) {
            paint.color = Color.parseColor(color); canvas.drawRoundRect(x, y, x + w, y + h, radius, radius, paint)
        }
        if (!qrOnly) {
            paint.color = Color.parseColor("#EAE6FB"); canvas.drawCircle(155f, 102f, 98f, paint)
            rect(34f, 58f, 122f, 92f, 14f, "#FFFFFF")
            rect(47f, 72f, 64f, 7f, 3f, "#D8D1F7"); rect(47f, 89f, 87f, 6f, 3f, "#EEEBF8")
            rect(47f, 105f, 70f, 6f, 3f, "#EEEBF8"); rect(47f, 123f, 42f, 12f, 5f, "#6A53DC")
            rect(163f, 18f, 101f, 174f, 22f, "#26263E"); rect(170f, 25f, 87f, 160f, 17f, "#FFFFFF")
            rect(195f, 30f, 37f, 6f, 3f, "#26263E")
            canvas.save(); canvas.translate(184f, 65f); canvas.scale(.52f, .52f)
        }
        rect(0f, 0f, 116f, 116f, 16f, "#F4F1FD")
        for ((x, y) in listOf(15f to 15f, 69f to 15f, 15f to 69f)) {
            rect(x, y, 32f, 32f, 5f, "#6A53DC"); rect(x + 6, y + 6, 20f, 20f, 2f, "#F4F1FD")
            rect(x + 11, y + 11, 10f, 10f, 1f, "#6A53DC")
        }
        for ((x, y) in listOf(55f to 16f, 54f to 40f, 16f to 55f, 40f to 55f, 55f to 55f, 70f to 55f,
            94f to 55f, 55f to 71f, 71f to 72f, 86f to 71f, 94f to 88f, 70f to 94f, 55f to 94f, 86f to 94f)) {
            rect(x, y, 8f, 8f, 1f, "#6A53DC")
        }
        if (!qrOnly) {
            canvas.restore(); rect(188f, 143f, 52f, 23f, 10f, "#EAE6FB")
            paint.color = Color.parseColor("#6A53DC"); paint.textSize = 15f; paint.typeface = Typeface.DEFAULT_BOLD
            canvas.drawText("✓", 207f, 160f, paint)
        }
        canvas.restore()
    }
}
