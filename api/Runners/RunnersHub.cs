using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace DoPilot.Api.Runners;

/// <summary>
/// One hub for both sides. Runners (`kora start`) register and report task progress; the web app watches
/// runners and dispatches tasks. Each runner decides for itself whose tasks it accepts (runner.yml dispatch.accept).
/// </summary>
[Authorize]
public sealed partial class RunnersHub(RunnerRegistry registry, ReleaseQueues queues, UserDirectory users, ILogger<RunnersHub> log) : Hub
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
            foreach (var queue in queues.RunningOn(runner.Id))
            {
                queue.RunnerOffline("The runner went offline.");
                await BroadcastQueue(queue);
            }
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

    public async Task TaskStarted(string taskId, JsonElement info)
    {
        await Report(taskId, KoraTaskState.Running, "TaskStarted", info);
        await BroadcastRunners(); // the Runners page shows what each runner is working on
    }

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
        if (runner.Registration.Repos.First(r => r.Key == repo).Local == false)
            throw new HubException($"\"{repo}\" is GitHub only on runner {runner.Registration.Name} (no local clone), so tasks cannot run on it.");

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

    // ---- pull requests: gh runs on a runner's machine, with that machine's GitHub login ----

    public IReadOnlyList<PullRequestRepo> PullRequestRepos() => registry.PullRequestRepos(CurrentUser);

    public Task<JsonElement> ListPullRequests(string runnerId, string github) =>
        AskGitHub(runnerId, github, new { action = "list", repo = github, from = CurrentUser });

    public Task<JsonElement> ApprovePullRequest(string runnerId, string github, int number, string? body) =>
        AskGitHub(runnerId, github, new { action = "approve", repo = github, number, body, from = CurrentUser });

    public Task<JsonElement> MergePullRequest(string runnerId, string github, int number, string method, bool deleteBranch)
    {
        if (method is not ("merge" or "squash" or "rebase")) throw new HubException("Merge method must be merge, squash or rebase.");
        return AskGitHub(runnerId, github, new { action = "merge", repo = github, number, method, deleteBranch, from = CurrentUser });
    }

    // ---- repository settings: read with gh api, saved with gh repo edit (kora 0.2.5+) ----

    public Task<JsonElement> RepositorySettings(string runnerId, string github) =>
        AskGitHub(runnerId, github, new { action = "settings", repo = github, from = CurrentUser });

    /// <summary>changes holds only the changed fields; the runner maps them to gh repo edit flags and ignores the rest.</summary>
    public Task<JsonElement> UpdateRepositorySettings(string runnerId, string github, JsonElement changes)
    {
        if (changes.ValueKind != JsonValueKind.Object) throw new HubException("Settings changes must be an object.");
        return AskGitHub(runnerId, github, new { action = "editSettings", repo = github, changes, from = CurrentUser });
    }

    // ---- repositories added from the web app, saved in the runner's runner.yml: GitHub only (kora 0.2.6+) ----

    /// <summary>The caller's own runners: the ones they may add repositories to.</summary>
    public IReadOnlyList<PullRequestRoute> OwnRunners() => registry.OwnRunners(CurrentUser);

    public Task<JsonElement> AddRepository(string runnerId, string github, bool deployment) =>
        ManageRepository(runnerId, new { action = "add", repo = CheckRepoName(github.Trim()), deployment, from = CurrentUser });

    /// <summary>Marks a repository as a deployment (yml) repo or not, in the runner's runner.yml (kora 0.2.9+).</summary>
    public Task<JsonElement> SetDeploymentRepository(string runnerId, string github, bool deployment) =>
        ManageRepository(runnerId, new { action = "setDeployment", repo = CheckRepoName(github), deployment, from = CurrentUser });

    public Task<JsonElement> RemoveRepository(string runnerId, string github) =>
        ManageRepository(runnerId, new { action = "remove", repo = CheckRepoName(github), from = CurrentUser });

    // ---- local clones on the runner's machine, like the FE/BE repos kora init sets up (kora 0.2.7+) ----

    /// <summary>Git folders the runner found near its clones and in the usual code folders, for the add dialog to offer.</summary>
    public Task<JsonElement> LocalRepositoryCandidates(string runnerId) =>
        ManageRepository(runnerId, new { action = "candidates", from = CurrentUser });

    /// <summary>The runner checks the folder is a git clone, reads its GitHub remote and saves it in runner.yml.</summary>
    public Task<JsonElement> AddLocalRepository(string runnerId, string path, string? key, bool deployment)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new HubException("Enter the folder of the clone on the runner's machine.");
        return ManageRepository(runnerId, new { action = "addLocal", path = path.Trim(), key = key?.Trim(), deployment, from = CurrentUser });
    }

    /// <summary>What a runner offers is its owner's to change, so only the owner may.</summary>
    private Task<JsonElement> ManageRepository(string runnerId, object request)
    {
        var runner = registry.Get(runnerId) ?? throw new HubException("That runner is offline.");
        if (runner.Owner.Sub != CurrentUser.Sub) throw new HubException("Only the runner's owner can change its repositories.");
        return AskRunner(runner, "ManageRepository", request);
    }

    private static string CheckRepoName(string github) =>
        RepoName().IsMatch(github) ? github : throw new HubException("Use owner/name, for example selise/deploy-config.");

    [System.Text.RegularExpressions.GeneratedRegex(@"^[\w.-]+/[\w.-]+$")]
    private static partial System.Text.RegularExpressions.Regex RepoName();

    /// <summary>Sends a gh request to the runner, after checking the caller may use it for that repository.</summary>
    private Task<JsonElement> AskGitHub(string runnerId, string github, object request)
    {
        var runner = registry.Get(runnerId) ?? throw new HubException("That runner is offline.");
        if (!runner.Registration.Repos.Any(repo => string.Equals(repo.Github, github, StringComparison.OrdinalIgnoreCase)))
            throw new HubException($"Runner {runner.Registration.Name} has no repository {github}.");
        if (!RunnerRegistry.MayUse(runner, CurrentUser))
            throw new HubException($"Runner {runner.Registration.Name} only accepts requests from its owner and the people its dispatch.accept lists.");
        return AskRunner(runner, "GitHub", request);
    }

    /// <summary>Calls the runner and waits for its answer ({ ok, error?, ... }).</summary>
    private async Task<JsonElement> AskRunner(Runner runner, string method, object request)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try
        {
            return await Clients.Client(runner.ConnectionId).InvokeAsync<JsonElement>(method, request, timeout.Token);
        }
        catch (OperationCanceledException)
        {
            throw new HubException($"Runner {runner.Registration.Name} did not answer within a minute.");
        }
        catch (Exception error) when (error is not HubException)
        {
            log.LogWarning("gh request to {Runner} failed: {Error}", runner.Id, error.Message);
            throw new HubException($"Runner {runner.Registration.Name} could not answer ({error.Message}). It may need a newer kora (PRs 0.2.3, repo settings 0.2.5, adding repositories 0.2.6, local clones 0.2.7, deployment repos 0.2.9, environments 0.2.11): run kora update there and restart kora start.");
        }
    }

    // ---- Release > Environments (kora 0.2.11+): what dev / stage / prod run in a deployment (yml) repo ----

    public Task<JsonElement> Environments(string runnerId, string github) =>
        AskGitHub(runnerId, github, new { action = "environments", repo = github, from = CurrentUser });

    /// <summary>
    /// Opens a promote or rollback PR in the deployment repo (and merges it when asked): { service, env: stg|production,
    /// kind: promote|rollback, image, merge }. The runner re-reads the repo and checks the image before changing anything.
    /// </summary>
    public Task<JsonElement> DeployEnvironment(string runnerId, string github, JsonElement deployment)
    {
        if (deployment.ValueKind != JsonValueKind.Object) throw new HubException("The deployment must be an object.");
        return AskGitHub(runnerId, github, new { action = "deployEnv", repo = github, deployment, from = CurrentUser });
    }

    // ---- Release > Ready to stage (kora 0.2.8+). The web app keeps the board (Blocks Data); merge queues run on a runner ----

    public Task<JsonElement> ReleaseBoard(string runnerId, string github) =>
        AskGitHub(runnerId, github, new { action = "board", repo = github, from = CurrentUser });

    /// <summary>Joins the repository's board group for MergeQueueChanged, and returns its latest queue.</summary>
    public async Task<ReleaseQueueView?> WatchRelease(string github)
    {
        if (!registry.PullRequestRepos(CurrentUser).Any(repo => string.Equals(repo.Github, github, StringComparison.OrdinalIgnoreCase)))
            throw new HubException($"You have no runner for {github}.");
        await Groups.AddToGroupAsync(Context.ConnectionId, ReleaseGroup(github));
        return queues.Latest(github)?.View();
    }

    public Task StopWatchingRelease(string github) => Groups.RemoveFromGroupAsync(Context.ConnectionId, ReleaseGroup(github));

    /// <summary>Starts merging the PRs in this order, one at a time; only one queue runs per repository.</summary>
    public async Task<ReleaseQueueView> StartMergeQueue(string runnerId, string github, IReadOnlyList<ReleaseQueueRequestItem> items, string method, bool deleteBranch)
    {
        if (method is not ("merge" or "squash" or "rebase")) throw new HubException("Merge method must be merge, squash or rebase.");
        if (items.Count == 0) throw new HubException("Move pull requests to Ready to stage first.");
        if (items.Count > 50 || items.Select(item => item.Number).Distinct().Count() != items.Count) throw new HubException("The queue needs up to 50 different pull requests.");
        var runner = registry.Get(runnerId) ?? throw new HubException("That runner is offline.");
        if (!runner.Registration.Repos.Any(repo => string.Equals(repo.Github, github, StringComparison.OrdinalIgnoreCase)))
            throw new HubException($"Runner {runner.Registration.Name} has no repository {github}.");
        if (!RunnerRegistry.MayUse(runner, CurrentUser))
            throw new HubException($"Runner {runner.Registration.Name} only accepts requests from its owner and the people its dispatch.accept lists.");

        var queue = new ReleaseQueue
        {
            Id = Guid.NewGuid().ToString("n"),
            Repo = github,
            RunnerId = runner.Id,
            RunnerName = runner.Registration.Name,
            StartedBy = CurrentUser,
            Method = method,
            Items = items.Select(item => new ReleaseQueueItem { Number = item.Number, Title = item.Title }).ToList()
        };
        if (queues.TryStart(queue) is { } running)
            throw new HubException($"A merge queue is already running for {github} (started by {running.StartedBy.Email ?? running.StartedBy.Sub}).");

        JsonElement answer;
        try
        {
            answer = await AskRunner(runner, "MergeQueue", new
            {
                queueId = queue.Id, repo = github, numbers = items.Select(item => item.Number), method, deleteBranch, from = CurrentUser
            });
        }
        catch
        {
            queues.Remove(queue.Id);
            throw;
        }
        if (!answer.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True)
        {
            queues.Remove(queue.Id);
            throw new HubException(answer.TryGetProperty("error", out var error) ? error.GetString() : "The runner did not start the queue.");
        }
        log.LogInformation("Merge queue {Queue} for {Repo} on {Runner} started by {User}", queue.Id, github, runner.Id, CurrentUser.Sub);
        await BroadcastQueue(queue);
        return queue.View();
    }

    /// <summary>Stops the queue after the PR it is working on; only who started it or the runner's owner may.</summary>
    public async Task CancelMergeQueue(string queueId)
    {
        var queue = queues.Get(queueId) ?? throw new HubException("Unknown merge queue.");
        var runner = registry.Get(queue.RunnerId) ?? throw new HubException("That runner is offline.");
        if (queue.StartedBy.Sub != CurrentUser.Sub && runner.Owner.Sub != CurrentUser.Sub)
            throw new HubException("Only who started the queue or the runner's owner can cancel it.");
        await Clients.Client(runner.ConnectionId).SendAsync("CancelMergeQueue", queueId);
    }

    /// <summary>Runner side: progress of a merge queue, accepted only from the runner running it.</summary>
    public async Task MergeQueueProgress(string queueId, JsonElement update)
    {
        var queue = queues.Get(queueId) ?? throw new HubException("Unknown merge queue.");
        var runner = registry.ByConnection(Context.ConnectionId);
        if (runner is null || runner.Id != queue.RunnerId) throw new HubException("This connection is not running that queue.");
        queue.Apply(update);
        await BroadcastQueue(queue);
    }

    private Task BroadcastQueue(ReleaseQueue queue) => Clients.Group(ReleaseGroup(queue.Repo)).SendAsync("MergeQueueChanged", queue.View());

    private static string ReleaseGroup(string github) => $"release:{github.ToLowerInvariant()}";

    // ---- helpers ----

    /// <summary>Forwards a runner's report to the task's sender, after checking it came from that task's runner.</summary>
    private async Task Report(string taskId, KoraTaskState? state, string method, JsonElement payload)
    {
        var task = registry.Task(taskId) ?? throw new HubException("Unknown task.");
        var runner = registry.ByConnection(Context.ConnectionId);
        if (runner is null || runner.Id != task.RunnerId) throw new HubException("This connection is not running that task.");
        if (state is not null) task.MoveTo(state.Value);
        await Clients.Group(UserGroup(task.From.Sub)).SendAsync(method, taskId, payload);
    }

    private Task BroadcastRunners() => Clients.Group(Watchers).SendAsync("RunnersChanged", registry.List());

    private KoraUser CurrentUser => (KoraUser)Context.Items["user"]!;

    private static string UserGroup(string sub) => $"user:{sub}";
}
