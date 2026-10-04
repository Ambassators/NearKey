package dev.nearkey.passive

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View

/** Small, decorative device illustration that scales inside the view's padded bounds. */
internal class SetupArtwork(context: Context, private val qrOnly: Boolean = false) : View(context) {
    private val green = Color.rgb(23, 75, 59)
    private val mint = Color.rgb(217, 241, 199)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val rect = RectF()
    private val path = Path()
    private val brandTypeface = Typeface.create(resources.getFont(R.font.dm_sans), Typeface.BOLD)

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val availableWidth = (width - paddingLeft - paddingRight).toFloat()
        val availableHeight = (height - paddingTop - paddingBottom).toFloat()
        if (availableWidth <= 0f || availableHeight <= 0f) return
        val artworkWidth = if (qrOnly) 116f else 320f
        val artworkHeight = if (qrOnly) 116f else 160f
        val scale = minOf(availableWidth / artworkWidth, availableHeight / artworkHeight)
        val checkpoint = canvas.save()
        canvas.translate(
            paddingLeft + (availableWidth - artworkWidth * scale) / 2f,
            paddingTop + (availableHeight - artworkHeight * scale) / 2f
        )
        canvas.scale(scale, scale)
        if (qrOnly) drawQr(canvas) else drawDevices(canvas)
        canvas.restoreToCount(checkpoint)
    }

    private fun fill(color: Int) {
        paint.style = Paint.Style.FILL
        paint.color = color
        paint.alpha = 255
    }

    private fun outline(width: Float = 2.6f) {
        paint.style = Paint.Style.STROKE
        paint.color = green
        paint.alpha = 255
        paint.strokeWidth = width
    }

    private fun rounded(canvas: Canvas, left: Float, top: Float, right: Float, bottom: Float, radius: Float) {
        rect.set(left, top, right, bottom)
        canvas.drawRoundRect(rect, radius, radius, paint)
    }

    private fun drawDevices(canvas: Canvas) {
        // The soft mint rings keep the connection legible without a large colored panel.
        fill(mint)
        paint.alpha = 65
        canvas.drawCircle(265f, 79f, 62f, paint)
        paint.alpha = 85
        canvas.drawCircle(265f, 79f, 50f, paint)
        paint.alpha = 100
        canvas.drawCircle(265f, 79f, 39f, paint)

        outline()
        rounded(canvas, 28f, 43f, 141f, 115f, 4f)
        // A slim laptop base with a lightly curved lower edge.
        path.reset()
        path.moveTo(14f, 115f)
        path.lineTo(155f, 115f)
        path.lineTo(155f, 120f)
        path.quadTo(155f, 123f, 152f, 123f)
        path.lineTo(17f, 123f)
        path.quadTo(14f, 123f, 14f, 120f)
        path.close()
        canvas.drawPath(path, paint)

        outline(2.4f)
        canvas.drawCircle(84.5f, 79f, 17f, paint)
        rect.set(77.5f, 62f, 91.5f, 96f)
        canvas.drawOval(rect, paint)
        canvas.drawLine(67.5f, 73f, 101.5f, 73f, paint)
        canvas.drawLine(67.5f, 85f, 101.5f, 85f, paint)

        fill(Color.rgb(95, 171, 75))
        for (index in 0..4) canvas.drawCircle(158f + index * 14f, 80f, 2.6f, paint)

        fill(Color.rgb(251, 252, 248))
        rounded(canvas, 239f, 33f, 291f, 130f, 8f)
        outline()
        rounded(canvas, 239f, 33f, 291f, 130f, 8f)
        fill(green)
        rounded(canvas, 250f, 66f, 280f, 96f, 7f)
        fill(Color.WHITE)
        paint.typeface = brandTypeface
        paint.textSize = 23f
        paint.textAlign = Paint.Align.CENTER
        val baseline = 81f - (paint.ascent() + paint.descent()) / 2f
        canvas.drawText("n", 265f, baseline, paint)
    }

    /** An illustrative QR motif; actual enrollment codes are handled by the scanner. */
    private fun drawQr(canvas: Canvas) {
        fill(mint)
        rounded(canvas, 0f, 0f, 116f, 116f, 18f)
        fill(Color.WHITE)
        rounded(canvas, 3f, 3f, 113f, 113f, 15f)
        fill(green)
        val module = 4f
        val start = 16f
        for (row in 0 until 21) {
            for (column in 0 until 21) {
                val finder = when {
                    row < 7 && column < 7 -> finderModule(row, column)
                    row < 7 && column >= 14 -> finderModule(row, column - 14)
                    row >= 14 && column < 7 -> finderModule(row - 14, column)
                    // A one-module separator around each finder keeps the motif tidy.
                    row <= 7 && column <= 7 -> false
                    row <= 7 && column >= 13 -> false
                    row >= 13 && column <= 7 -> false
                    row == 6 || column == 6 -> (row + column) % 2 == 0
                    else -> ((row * 17 + column * 11 + row * column * 3) % 7) < 3
                }
                if (finder) {
                    val left = start + column * module
                    val top = start + row * module
                    canvas.drawRect(left, top, left + module, top + module, paint)
                }
            }
        }
    }

    private fun finderModule(row: Int, column: Int): Boolean =
        row == 0 || row == 6 || column == 0 || column == 6 ||
            (row in 2..4 && column in 2..4)
}
