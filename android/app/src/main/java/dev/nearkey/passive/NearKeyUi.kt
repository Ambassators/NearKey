package dev.nearkey.passive

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Clean website rows and scrollable setup screens, with actions above system navigation. */
class NearKeyUi(private val context: Context) {
    private val ink = Color.rgb(21, 60, 48)
    private val green = Color.rgb(23, 75, 59)
    private val muted = Color.rgb(99, 113, 105)
    private val mint = Color.rgb(217, 241, 199)
    private val line = Color.rgb(226, 231, 225)
    private val pageColor = Color.rgb(251, 252, 248)
    private val bodyFont = context.resources.getFont(R.font.dm_sans)
    private val headingFont = context.resources.getFont(R.font.manrope)
    val root = FrameLayout(context).apply { setBackgroundColor(pageColor) }
    private lateinit var page: LinearLayout
    private lateinit var content: LinearLayout
    private var statusLabel: TextView? = null
    private var loginLabel: TextView? = null
    private var demoResetButton: Button? = null
    private val connectionLabels = mutableMapOf<String, TextView>()
    private val connectionRows = mutableMapOf<String, View>()
    private val connectionAddresses = mutableMapOf<String, String>()

    init {
        if (Build.VERSION.SDK_INT >= 29) root.isForceDarkAllowed = false
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
    }

    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
    private fun rounded(color: Int, radius: Int = 10, stroke: Int? = null) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
        stroke?.let { setStroke(dp(1), it) }
    }
    private fun ripple(background: GradientDrawable) = RippleDrawable(
        ColorStateList.valueOf(Color.argb(35, 100, 150, 110)), background, rounded(Color.WHITE))
    private fun column() = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private fun row() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun label(value: String, size: Float = 16f, color: Int = ink, bold: Boolean = false) = TextView(context).apply {
        text = value; textSize = size; setTextColor(color)
        typeface = Typeface.create(bodyFont, if (bold) Typeface.BOLD else Typeface.NORMAL)
        setLineSpacing(dp(2).toFloat(), 1f)
    }
    private fun LinearLayout.space(height: Int) { addView(View(context), LinearLayout.LayoutParams(1, dp(height))) }
    private fun LinearLayout.copy(value: String, size: Float = 16f, color: Int = muted, bold: Boolean = false): TextView =
        label(value, size, color, bold).also { addView(it) }
    private fun heading(value: String): TextView = content.copy(value, 30f, ink, true).apply {
        typeface = Typeface.create(headingFont, Typeface.BOLD)
        ViewCompat.setAccessibilityHeading(this, true)
    }
    private fun button(value: String, secondary: Boolean = false, action: () -> Unit): Button = Button(context).apply {
        text = value; textSize = 16f; isAllCaps = false
        typeface = Typeface.create(bodyFont, Typeface.BOLD)
        setTextColor(if (secondary) green else Color.WHITE)
        background = ripple(rounded(if (secondary) Color.TRANSPARENT else green))
        stateListAnimator = null
        minHeight = dp(52); minimumHeight = dp(52)
        setPadding(dp(16), dp(12), dp(16), dp(12))
        setOnClickListener { action() }
    }
    private fun LinearLayout.action(value: String, enabled: Boolean = true, secondary: Boolean = false, action: () -> Unit) {
        addView(button(value, secondary, action).apply { isEnabled = enabled; alpha = if (enabled) 1f else .45f },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    private fun prepare() {
        root.removeAllViews(); connectionLabels.clear(); connectionRows.clear(); connectionAddresses.clear(); statusLabel = null; loginLabel = null; demoResetButton = null
        page = column()
        content = column().apply { setPadding(dp(24), dp(18), dp(24), dp(20)) }
        page.addView(ScrollView(context).apply {
            isFillViewport = true; clipToPadding = false; addView(content)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(page, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        content.addView(row().apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            addView(ImageView(context).apply {
                setImageResource(R.drawable.ic_key)
                imageTintList = ColorStateList.valueOf(Color.BLACK)
                scaleType = ImageView.ScaleType.FIT_CENTER
                background = rounded(mint, 9)
                setPadding(dp(5), dp(5), dp(5), dp(5))
            }, LinearLayout.LayoutParams(dp(36), dp(36)))
            addView(label("nearKey", 23f, ink, true).apply {
                typeface = Typeface.create(headingFont, Typeface.BOLD); setPadding(dp(10), 0, 0, 0)
            })
        })
        content.space(32)
    }
    private fun status(message: String) {
        statusLabel = content.copy(message, 14f).apply {
            setPadding(0, dp(12), 0, dp(12))
            visibility = if (message.isBlank()) View.GONE else View.VISIBLE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
    }
    private fun flexibleSpace(minimum: Int = 24) {
        content.addView(View(context).apply { minimumHeight = dp(minimum) },
            LinearLayout.LayoutParams(1, dp(minimum), 1f))
    }

    fun wizard(step: Int, origin: String, code: String, manual: Boolean, loaded: Boolean,
        busy: Boolean, available: Boolean, status: String, canClose: Boolean,
        start: () -> Unit, importKeys: () -> Unit, scan: () -> Unit, toggleManual: () -> Unit, enroll: () -> Unit,
        bluetooth: () -> Unit, back: () -> Unit, retry: () -> Unit,
        edit: (String, String) -> Unit) {
        prepare()
        when (step) {
            1 -> {
                heading("Pair a new provider")
                content.space(10)
                content.copy("Connect a website to use your phone as a nearby key.")
                content.space(22)
                content.addView(SetupArtwork(context), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(178)))
                content.space(20)
                info("1", "Connect a website", "Open a supported website on your computer.")
                content.space(20)
                info("2", "Keep your phone nearby", "Your phone completes sign-in over Bluetooth.")
                status(status)
                flexibleSpace()
                content.action("Import keys", available, secondary = true, action = importKeys)
                content.space(8)
                content.action("Get started", available, action = start)
            }
            2 -> {
                heading(if (loaded || canClose) "Connect a website" else "Connect your first website")
                content.space(10)
                content.copy(if (loaded) "Check the website address, then securely connect this phone." else
                    "Open NearKey setup on your computer and scan the QR code.")
                content.space(28)
                if (loaded && !manual) {
                    content.addView(column().apply {
                        background = rounded(Color.WHITE, 12, line)
                        setPadding(dp(20), dp(22), dp(20), dp(22))
                        copy("WEBSITE TO CONNECT", 11f, muted, true); space(10)
                        copy(try { PhoneOrigin.parse(origin).host } catch (_: Exception) { origin }, 22f, ink, true)
                        space(6); copy(origin, 14f); space(16)
                        copy("Only continue if you recognize this address.", 14f)
                    })
                } else if (!manual) {
                    content.addView(SetupArtwork(context, qrOnly = true),
                        LinearLayout.LayoutParams(dp(150), dp(150)).apply { gravity = Gravity.CENTER_HORIZONTAL })
                }
                if (manual) {
                    val address = input("Website server address", origin, false)
                    val pairing = input("Pairing code", code, true)
                    content.copy("Website server address", 13f, ink, true); content.space(8); content.addView(address)
                    content.space(20)
                    content.copy("Pairing code", 13f, ink, true); content.space(8); content.addView(pairing)
                    val watcher = object : TextWatcher {
                        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                        override fun afterTextChanged(s: Editable?) { edit(address.text.toString(), pairing.text.toString()) }
                    }
                    address.addTextChangedListener(watcher); pairing.addTextChangedListener(watcher)
                    address.isEnabled = !busy; pairing.isEnabled = !busy
                }
                status(status)
                flexibleSpace()
                if (!loaded && !manual) {
                    content.action("Scan setup QR code", available && !busy, action = scan)
                    content.space(8)
                }
                if (loaded || manual) {
                    content.action(if (busy) "Connecting website…" else "Connect website", available && !busy, action = enroll)
                    content.space(8)
                }
                if (!loaded) content.action(if (manual) "Hide manual details" else "Enter details manually",
                    available && !busy, true, toggleManual)
                content.action("Back", available && !busy, true, back)
            }
            3 -> {
                heading("One last connection")
                content.space(10)
                content.copy("Enable Bluetooth so your browser can find this phone, even when the screen is off.")
                content.space(24)
                content.addView(SetupArtwork(context), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(152)))
                content.space(24)
                info("1", "Allow Nearby devices", "Tap below and allow Bluetooth access when prompted.")
                content.space(22)
                info("2", "Choose this phone", "Select your phone in the computer’s Bluetooth chooser, then continue in the browser.")
                status(status)
                flexibleSpace()
                content.action("Connect Bluetooth & finish", available, action = bluetooth)
                content.space(8)
                content.action("Retry website connection", available, true, retry)
            }
        }
    }

    private fun input(hintText: String, value: String, secret: Boolean) = EditText(context).apply {
        hint = hintText; setText(value); textSize = 16f; setTextColor(ink); setHintTextColor(muted)
        typeface = bodyFont
        inputType = InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_URI
        setSingleLine(true); isSaveEnabled = false
        minHeight = dp(52)
        setPadding(dp(16), dp(14), dp(16), dp(14)); background = rounded(Color.WHITE, 10, line)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun info(number: String, title: String, description: String) {
        content.addView(row().apply {
            gravity = Gravity.TOP
            addView(DeviceIcon(context, laptop = number == "1", color = green),
                LinearLayout.LayoutParams(dp(28), dp(28)).apply { topMargin = dp(2) })
            addView(column().apply {
                setPadding(dp(16), 0, 0, 0); copy(title, 17f, ink, true); space(5); copy(description, 15f)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        })
    }

    fun websites(sites: List<ConnectedWebsite>, statuses: Map<String, Pair<Boolean, String>>,
        login: String, message: String, add: () -> Unit, details: (ConnectedWebsite) -> Unit) {
        prepare()
        heading("Your websites"); content.space(10)
        content.copy("Sign in with your nearby phone.")
        content.space(14)
        loginLabel = content.copy(login, 13f).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        content.space(24)
        sites.forEach { site ->
            connectionAddresses[site.origin] = site.address
            content.addView(row().apply {
                background = ripple(rounded(Color.TRANSPARENT))
                setPadding(0, dp(20), 0, dp(20))
                minimumHeight = dp(80); isClickable = true; isFocusable = true
                contentDescription = "${site.address}. Website connection details"
                setOnClickListener { details(site) }
                addView(label(site.address.first().uppercase(), 20f, Color.WHITE, true).apply {
                    gravity = Gravity.CENTER; background = rounded(green, 9)
                    setTextSize(TypedValue.COMPLEX_UNIT_DIP, 20f)
                }, LinearLayout.LayoutParams(dp(40), dp(40)))
                addView(label(site.address, 17f, ink, true).apply {
                    setPadding(dp(16), 0, dp(8), 0)
                    maxLines = 2; ellipsize = TextUtils.TruncateAt.END
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                connectionLabels[site.origin] = label("", 13f).also {
                    addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                }
                addView(label("›", 26f, muted).apply { setPadding(dp(12), 0, 0, 0) })
            }.also { connectionRows[site.origin] = it })
            content.addView(View(context).apply { setBackgroundColor(line); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)))
        }
        status(message)
        val footer = column().apply {
            setPadding(dp(24), dp(14), dp(24), dp(18))
            addView(row().apply {
                gravity = Gravity.CENTER
                addView(DeviceIcon(context, color = green), LinearLayout.LayoutParams(dp(20), dp(20)))
                addView(label("Keep your phone nearby", 13f, muted).apply { setPadding(dp(8), 0, 0, 0) })
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            space(14)
            action("Add website", action = add)
        }
        page.addView(footer, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        updateConnections(statuses)
    }

    fun showDemoReset(visible: Boolean, enabled: Boolean, action: () -> Unit) {
        demoResetButton?.let(root::removeView)
        demoResetButton = null
        if (!visible) return
        demoResetButton = button("reset\ndemo", action = action).apply {
            contentDescription = "reset demo"
            textSize = 12f; gravity = Gravity.CENTER; includeFontPadding = false
            minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
            setPadding(dp(6), dp(6), dp(6), dp(6))
            backgroundTintList = null
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(55, 255, 255, 255)),
                GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(green) },
                GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) })
            elevation = dp(6).toFloat()
            isEnabled = enabled; alpha = if (enabled) 1f else .45f
        }.also {
            root.addView(it, FrameLayout.LayoutParams(dp(64), dp(64), Gravity.TOP or Gravity.RIGHT).apply {
                topMargin = dp(12); rightMargin = dp(16)
            })
        }
    }

    fun updateStatus(message: String) {
        statusLabel?.apply {
            text = message
            visibility = if (message.isBlank()) View.GONE else View.VISIBLE
        }
    }
    fun updateLogin(value: String) {
        loginLabel?.apply {
            if (text.toString() != value) text = value
            setTextColor(if (value.startsWith("Verifying")) green else muted)
        }
    }
    fun updateConnections(statuses: Map<String, Pair<Boolean, String>>) {
        connectionLabels.forEach { (origin, label) ->
            val state = statuses[origin]
            label.text = if (state?.first == true) "● Ready" else "● Offline"
            label.contentDescription = if (state?.first == true) "Ready for sign-in" else state?.second ?: "Offline"
            connectionRows[origin]?.contentDescription = "${connectionAddresses[origin]}. ${label.contentDescription}. Website connection details"
            label.tooltipText = label.contentDescription
            label.setTextColor(if (state?.first == true) green else muted)
        }
    }
}

private class DeviceIcon(context: Context, private val laptop: Boolean = false, color: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color; style = Paint.Style.STROKE; strokeWidth = 1.8f
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val scale = minOf(width, height) / 28f
        canvas.save(); canvas.translate((width - 28 * scale) / 2, (height - 28 * scale) / 2); canvas.scale(scale, scale)
        if (laptop) {
            canvas.drawRoundRect(4f, 5f, 24f, 20f, 2f, 2f, paint)
            canvas.drawRoundRect(1f, 22f, 27f, 24f, 1f, 1f, paint)
        } else {
            canvas.drawRoundRect(7f, 2f, 21f, 26f, 3f, 3f, paint)
            canvas.drawLine(12f, 5f, 16f, 5f, paint); canvas.drawLine(13f, 23f, 15f, 23f, paint)
        }
        canvas.restore()
    }
}
