import XCTest
import CryptoKit
@testable import NearKeyCore

final class NearKeyCoreTests: XCTestCase {
    let now: Int64 = 1_800_000_000_000
    func challenge() -> LoginChallenge {
        LoginChallenge(v: 2, id: "3c1d2b10-0580-432b-9d6c-e693dc998ec3", nonce: Data(repeating: 7, count: 32).base64URL,
                       phoneId: "iphone-contract", expiresAt: now + 60_000, purpose: "login", username: "admin",
                       serviceName: "NearKey", sessionId: "bound_session_123")
    }
    func request(_ value: LoginChallenge) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["v": 2, "type": "prove", "challengeId": value.id, "nonce": value.nonce])
    }

    func testChallengeExpiryIdentityAndSignedContext() throws {
        let value = challenge()
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try LoginChallenge.decode(data, phoneId: value.phoneId, now: now), value)
        XCTAssertThrowsError(try LoginChallenge.decode(data, phoneId: "other-phone", now: now))
        XCTAssertThrowsError(try LoginChallenge.decode(data, phoneId: value.phoneId, now: value.expiresAt))
        XCTAssertThrowsError(try LoginChallenge.decode(data, phoneId: value.phoneId, now: now - 1))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        json["extra"] = true
        XCTAssertThrowsError(try LoginChallenge.decode(JSONSerialization.data(withJSONObject: json), phoneId: value.phoneId, now: now))
        json.removeValue(forKey: "extra"); json["expiresAt"] = Double(now) + 0.5
        XCTAssertThrowsError(try LoginChallenge.decode(JSONSerialization.data(withJSONObject: json), phoneId: value.phoneId, now: now))
        json["expiresAt"] = now + 60_000; json["username"] = "admin\nforged"
        XCTAssertThrowsError(try LoginChallenge.decode(JSONSerialization.data(withJSONObject: json), phoneId: value.phoneId, now: now))
        XCTAssertEqual(value.approvalText, "NEARKEY-LOGIN-V2\n\(value.id)\n\(value.nonce)\niphone-contract\n1800000060000\nadmin\nNearKey\nbound_session_123")
    }

    func testBluetoothFrameAndStrictRequest() throws {
        let value = challenge()
        let bytes = try request(value)
        var buffer = RequestBuffer()
        var result: Data?
        let frame = bytes + Data([10])
        for start in stride(from: 0, to: frame.count, by: 20) {
            result = try buffer.append(frame.subdata(in: start..<min(start + 20, frame.count)))
        }
        XCTAssertEqual(result, bytes)
        try value.checkRequest(try XCTUnwrap(result), now: now)
        XCTAssertThrowsError(try buffer.append(Data([1])))
        buffer.clear()
        XCTAssertThrowsError(try buffer.append(Data(repeating: 1, count: 21)))
        XCTAssertThrowsError(try buffer.append(Data([1, 10, 2])))
        let invalid = [
            #"{"v":2,"v":2,"type":"prove","nonce":"x"}"#,
            #"{"v":true,"type":"prove","challengeId":"x","nonce":"x"}"#,
            #"{'v':2,'type':'prove','challengeId':'x','nonce':'x'}"#,
            #"{"v":2,"type":"prove","challengeId":"x","nonce":"x"} trailing"#,
            #"{"v":2,"type":"prove","challengeId":"x","nonce":"x","extra":1}"#
        ]
        for text in invalid { XCTAssertThrowsError(try value.checkRequest(Data(text.utf8), now: now)) }
        XCTAssertThrowsError(try value.checkRequest(bytes, now: value.expiresAt))
    }

    func testSetupValidationAndLocalOriginPolicy() throws {
        let qr = "nearkey://enroll?v=1&origin=http%3A%2F%2F192.168.1.3%3A5173&code=pair_code"
        let setup = try EnrollmentSetup(qr, allowHTTP: true)
        XCTAssertEqual(setup.origin.value, "http://192.168.1.3:5173")
        XCTAssertEqual(setup.code, "pair_code")
        XCTAssertThrowsError(try EnrollmentSetup(qr))
        for invalid in [qr + "&code=other", qr.replacingOccurrences(of: "v=1", with: "v=2"),
                        qr.replacingOccurrences(of: "pair_code", with: "%0Acode"),
                        qr.replacingOccurrences(of: "pair_code", with: "%FF"), qr + "#fragment",
                        qr.replacingOccurrences(of: "origin=", with: "origin%FF=")] {
            XCTAssertThrowsError(try EnrollmentSetup(invalid, allowHTTP: true))
        }
        for origin in ["https://user:secret@example.com", "https://example.com/path", "https://example.com?x=1",
                       "http://example.com", "http://192.168.1.3:0", "https://example.com#fragment"] {
            XCTAssertThrowsError(try PhoneOrigin(origin, allowHTTP: true))
        }
        XCTAssertEqual(try PhoneOrigin("https://EXAMPLE.com:443/").value, "https://example.com")
        XCTAssertThrowsError(try ConnectedWebsite(origin: PhoneOrigin("https://example.com"), phoneId: "phone", token: "bad\ncredential"))
    }

    func testCryptoKitSignaturesVerifyInExistingNodeServer() throws {
        let value = challenge()
        let key = P256.Signing.PrivateKey()
        let publicKey = WireProtocol.publicKey(key.publicKey)
        let code = "ios-contract-pairing"
        let enrollText = WireProtocol.enrollmentText(code: code, publicKey: publicKey)
        let enrollmentSignature = try key.signature(for: Data(enrollText.utf8)).derRepresentation.base64URL
        let loginSignature = try key.signature(for: Data(value.approvalText.utf8)).derRepresentation.base64URL
        let payload: [String: Any] = ["publicKey": publicKey, "pairingCode": code,
            "enrollmentSignature": enrollmentSignature, "loginSignature": loginSignature,
            "challenge": try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)),
            "approvalText": value.approvalText, "proof": String(data: try value.proof(signature: loginSignature), encoding: .utf8)!]
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("nearkey-ios-vector-\(UUID().uuidString).json")
        try JSONSerialization.data(withJSONObject: payload).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", repository.appendingPathComponent("ios/tools/check-contract.mjs").path, file.path]
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = pipe
        try process.run(); process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        XCTAssertEqual(process.terminationStatus, 0, output)
    }
}
