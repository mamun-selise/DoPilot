namespace DoPilot.Api.Runners;

public sealed record KoraUser(string Sub, string? Email, string? Name)
{
    /// <summary>
    /// One id per person. IAM's `sub` varies by token (a device-code token has the bare user id, a refreshed one
    /// "blocks|&lt;id&gt;"), so prefer `user_id` and otherwise strip the "provider|" prefix.
    /// </summary>
    public static string CanonicalId(string sub, string? userId) =>
        !string.IsNullOrEmpty(userId) ? userId : sub[(sub.LastIndexOf('|') + 1)..];
}

/// <summary>
/// What `kora start` sends from the runner's runner.yml and machine. Fields after Concurrency arrived in kora 0.2.2;
/// older runners leave them out, so they are optional.
/// </summary>
public sealed record RunnerRegistration(
    string Name,
    string? Machine,
    string? Version,
    IReadOnlyList<RunnerRepo> Repos,
    IReadOnlyList<string> Agents,
    int Concurrency,
    string? Platform = null,
    string? NodeVersion = null,
    string? ClaudeVersion = null,
    string? GithubAccount = null,
    IReadOnlyList<string>? AllowBinaries = null,
    IReadOnlyList<string>? DispatchAccept = null);

/// <summary>Local is false for a GitHub-only repository (no clone: PRs and settings, no tasks); null from kora before 0.2.6.</summary>
public sealed record RunnerRepo(string Key, string? Github, string? Branch = null, bool? Local = null);

public sealed record TaskSummary(string Id, string Repo, string Prompt, KoraUser From, KoraTaskState State, DateTimeOffset CreatedAt, DateTimeOffset? StartedAt);

public sealed record RunnerView(
    string Id,
    string Name,
    string? Machine,
    string? Version,
    KoraUser Owner,
    IReadOnlyList<RunnerRepo> Repos,
    IReadOnlyList<string> Agents,
    int Concurrency,
    int ActiveTasks,
    DateTimeOffset ConnectedAt,
    string? Platform,
    string? NodeVersion,
    string? ClaudeVersion,
    string? GithubAccount,
    IReadOnlyList<string> AllowBinaries,
    IReadOnlyList<string> DispatchAccept,
    int CompletedTasks,
    int FailedTasks,
    DateTimeOffset? LastActivityAt,
    IReadOnlyList<TaskSummary> CurrentTasks);

/// <summary>A GitHub repository on the PRs page and the runners whose gh login can reach it.</summary>
public sealed record PullRequestRepo(string Github, IReadOnlyList<PullRequestRoute> Runners);

/// <summary>Local is false when the runner has the repository only on GitHub (added from the web app).</summary>
public sealed record PullRequestRoute(string RunnerId, string RunnerName, KoraUser Owner, string? GithubAccount, bool Local = true);

public enum KoraTaskState { Queued, Running, Succeeded, Failed }

public sealed class KoraTask
{
    public required string Id { get; init; }
    public required string RunnerId { get; init; }
    public required string Repo { get; init; }
    public required string Prompt { get; init; }
    public required KoraUser From { get; init; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public KoraTaskState State { get; private set; } = KoraTaskState.Queued;
    public DateTimeOffset? StartedAt { get; private set; }
    public DateTimeOffset? FinishedAt { get; private set; }

    public bool IsActive => State is KoraTaskState.Queued or KoraTaskState.Running;

    public void MoveTo(KoraTaskState state)
    {
        State = state;
        if (state == KoraTaskState.Running) StartedAt ??= DateTimeOffset.UtcNow;
        if (state is KoraTaskState.Succeeded or KoraTaskState.Failed) FinishedAt ??= DateTimeOffset.UtcNow;
    }

    /// <summary>First line of the prompt, shortened, for the Runners page.</summary>
    public TaskSummary Summary()
    {
        var firstLine = Prompt.Split('\n', 2)[0].Trim();
        return new TaskSummary(Id, Repo, firstLine.Length > 140 ? firstLine[..140] + "…" : firstLine, From, State, CreatedAt, StartedAt);
    }
}
