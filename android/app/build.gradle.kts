plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android { namespace="dev.nearkeylite"; compileSdk=35
    defaultConfig { applicationId="dev.nearkeylite"; minSdk=31; targetSdk=35; versionCode=1; versionName="2.0" }
    buildTypes { debug { applicationIdSuffix=".debug" }; release { isMinifyEnabled=false } }
    compileOptions { sourceCompatibility=JavaVersion.VERSION_17; targetCompatibility=JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget="17" }
}
