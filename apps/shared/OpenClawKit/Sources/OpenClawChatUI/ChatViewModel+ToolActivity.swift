import Foundation

public typealias OpenClawChatToolActivityHandler = @MainActor @Sendable (
    _ id: String,
    _ name: String,
    _ isActive: Bool,
    _ sessionKey: String) -> Void

extension OpenClawChatViewModel {
    public func endPendingToolActivities() {
        self.turnToolCallsById = [:]
    }

    func reportToolActivityChanges(
        from previous: [String: OpenClawChatPendingToolCall],
        to current: [String: OpenClawChatPendingToolCall])
    {
        let priorActive = previous.filter { !$0.value.isComplete && $0.value.activity?.isVisible != false }
        let currentActive = current.filter { !$0.value.isComplete && $0.value.activity?.isVisible != false }
        for (id, call) in priorActive where currentActive[id] == nil {
            self.onToolActivity?(id, call.name, false, self.sessionKey)
        }
        for (id, call) in currentActive where priorActive[id] == nil {
            self.onToolActivity?(id, call.name, true, self.sessionKey)
        }
    }
}
