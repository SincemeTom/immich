import Flutter
import UIKit

/// Asks iOS for time to finish work after the app leaves the screen (about 30 seconds), before it is suspended
class BackgroundTimeApi {
  static func register(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "app.pixcellar/background_time", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "begin":
        var id = UIBackgroundTaskIdentifier.invalid
        id = UIApplication.shared.beginBackgroundTask(withName: "pixcellar.handoff") {
          UIApplication.shared.endBackgroundTask(id)
        }
        result(id == .invalid ? -1 : id.rawValue)
      case "end":
        if let raw = call.arguments as? Int, raw >= 0 {
          UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: raw))
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }
}
