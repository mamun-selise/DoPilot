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

/// <summary>What `kora start` sends from the runner's runner.yml.</summary>
public sealed record RunnerRegistration(
    string Name,
    string? Machine,
    string? Version,
    IReadOnlyList<RunnerRepo> Repos,
    IReadOnlyList<string> Agents,
    int Concurrency);

public sealed record RunnerRepo(string Key, string? Github);

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
    DateTimeOffset ConnectedAt);

public enum KoraTaskState { Queued, Running, Succeeded, Failed }

public sealed class KoraTask
{
    public required string Id { get; init; }
    public required string RunnerId { get; init; }
    public required string Repo { get; init; }
    public required string Prompt { get; init; }
    public required KoraUser From { get; init; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public KoraTaskState State { get; set; } = KoraTaskState.Queued;
}
