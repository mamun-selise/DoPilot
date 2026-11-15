using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace DoPilot.Api.Runners;

/// <summary>
/// One hub for both sides. Runners (`kora start`) register and report task progress; the web app watches
/// runners and dispatches tasks. Each runner decides for itself whose tasks it accepts (runner.yml dispatch.accept).
/// </summary>
[Authorize]
public sealed class RunnersHub(RunnerRegistry registry, UserDirectory users, ILogger<RunnersHub> log) : Hub
{
    private const string Watchers = "watchers";

    public override async Task OnConnectedAsync()
    {
        var user = await users.ResolveAsync(Context);
        Context.Items["user"] = user;
        await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(user.Sub));
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var (runner, orphaned) = registry.Disconnect(Context.ConnectionId);
        if (runner is not null)
        {
            log.LogInformation("Runner {Runner} disconnected", runner.Id);
            foreach (var task in orphaned)
                await Clients.Group(UserGroup(task.From.Sub)).SendAsync("TaskCompleted", task.Id, new { ok = false, error = "The runner went offline." });
            await BroadcastRunners();
        }
        await base.OnDisconnectedAsync(exception);
    }

    // ---- runner side ----

    public async Task RegisterRunner(RunnerRegistration registration)
    {
        if (string.IsNullOrWhiteSpace(registration.Name)) throw new HubException("A runner needs a name.");
        var runner = registry.Register(Context.ConnectionId, CurrentUser, registration);
        log.LogInformation("Runner {Runner} registered from {Machine} ({Version})", runner.Id, registration.Machine, registration.Version);
        await BroadcastRunners();
    }

    public Task TaskStarted(string taskId, JsonElement info) => Report(taskId, KoraTaskState.Running, "TaskStarted", info);

    public Task TaskLog(string taskId, JsonElement entry) => Report(taskId, null, "TaskLog", entry);

    public async Task TaskCompleted(string taskId, JsonElement outcome)
    {
        var ok = outcome.TryGetProperty("ok", out var value) && value.ValueKind == JsonValueKind.True;
        await Report(taskId, ok ? KoraTaskState.Succeeded : KoraTaskState.Failed, "TaskCompleted", outcome);
        await BroadcastRunners();
    }

    // ---- web side ----

    public async Task<IReadOnlyList<RunnerView>> WatchRunners()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, Watchers);
        return registry.List();
    }

    public async Task<string> DispatchTask(string runnerId, string repo, string prompt)
    {
        if (string.IsNullOrWhiteSpace(prompt)) throw new HubException("The task needs a prompt.");
        var runner = registry.Get(runnerId) ?? throw new HubException("That runner is offline.");
        if (!runner.Registration.Repos.Any(r => r.Key == repo)) throw new HubException($"Runner {runner.Registration.Name} has no repository \"{repo}\".");

        var user = CurrentUser;
        var task = registry.CreateTask(runner, user, repo, prompt);
        await Clients.Client(runner.ConnectionId).SendAsync("RunTask", new { id = task.Id, repo, prompt, from = user });
        log.LogInformation("Task {Task} sent to {Runner} by {User}", task.Id, runner.Id, user.Sub);
        await BroadcastRunners();
        return task.Id;
    }

    public async Task CancelTask(string taskId)
    {
        var task = registry.Task(taskId) ?? throw new HubException("Unknown task.");
        var runner = registry.Get(task.RunnerId) ?? throw new HubException("That runner is offline.");
        if (task.From.Sub != CurrentUser.Sub && runner.Owner.Sub != CurrentUser.Sub)
            throw new HubException("Only the sender or the runner's owner can cancel a task.");
        await Clients.Client(runner.ConnectionId).SendAsync("CancelTask", taskId);
    }

    // ---- helpers ----

    /// <summary>Forwards a runner's report to the task's sender, after checking it came from that task's runner.</summary>
    private async Task Report(string taskId, KoraTaskState? state, string method, JsonElement payload)
    {
        var task = registry.Task(taskId) ?? throw new HubException("Unknown task.");
        var runner = registry.ByConnection(Context.ConnectionId);
        if (runner is null || runner.Id != task.RunnerId) throw new HubException("This connection is not running that task.");
        if (state is not null) task.State = state.Value;
        await Clients.Group(UserGroup(task.From.Sub)).SendAsync(method, taskId, payload);
    }

    private Task BroadcastRunners() => Clients.Group(Watchers).SendAsync("RunnersChanged", registry.List());

    private KoraUser CurrentUser => (KoraUser)Context.Items["user"]!;

    private static string UserGroup(string sub) => $"user:{sub}";
}
