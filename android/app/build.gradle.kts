plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.nearkey.passive"
    // The installed SDK is android-37.0, not android-37. Do not rename SDK folders.
    compileSdk = 37
    compileSdkMinor = 0
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "dev.nearkey.passive"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "2.2"
    }
    buildFeatures { buildConfig = true }
    testOptions.unitTests.all {
        it.systemProperty("contractVectors", layout.buildDirectory.file("contract-vectors.json").get().asFile.absolutePath)
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("androidx.activity:activity:1.9.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
