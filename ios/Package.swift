// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NearKeyCore",
    platforms: [.macOS(.v13)],
    products: [.library(name: "NearKeyCore", targets: ["NearKeyCore"])],
    targets: [
        .target(name: "NearKeyCore", path: "NearKey/Core"),
        .testTarget(name: "NearKeyCoreTests", dependencies: ["NearKeyCore"], path: "Tests")
    ]
)
