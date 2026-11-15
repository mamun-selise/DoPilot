using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

namespace DoPilot.Api.Runners;

/// <summary>
/// Resolves who is on a hub connection. Access tokens carry only `sub`, so the email comes from the
/// IAM userinfo endpoint, called once per user with the caller's own token.
/// </summary>
public sealed class UserDirectory(IHttpClientFactory http, KoraOptions options, ILogger<UserDirectory> log)
{
    private readonly ConcurrentDictionary<string, KoraUser> _users = new();

    public async Task<KoraUser> ResolveAsync(HubCallerContext context)
    {
        var rawSub = context.User?.FindFirst("sub")?.Value ?? throw new HubException("Token has no subject.");
        var sub = KoraUser.CanonicalId(rawSub, context.User.FindFirst("user_id")?.Value);
        if (_users.TryGetValue(sub, out var known)) return known;

        // Browser sessions already carry the email (BlocksSessionHandler read it from IAM).
        if (context.User?.FindFirst("email")?.Value is { } email)
            return _users[sub] = new KoraUser(sub, email, context.User.FindFirst("name")?.Value);

        // Bounded so a slow IAM cannot hold up the connection; a failed lookup is not cached and is retried next time.
        var token = BearerToken(context.GetHttpContext());
        if (token is null) return new KoraUser(sub, null, null);
        try
        {
            using var timeout = new CancellationTokenSource(LookupTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, await UserInfoEndpointAsync(timeout.Token));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await http.CreateClient().SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("userinfo returned {Status} for {Sub}", (int)response.StatusCode, sub);
                return new KoraUser(sub, null, null);
            }
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
            var user = new KoraUser(sub, Text(json.RootElement, "email"), Text(json.RootElement, "name") ?? Text(json.RootElement, "preferred_username"));
            return _users[sub] = user;
        }
        catch (Exception error)
        {
            log.LogWarning("userinfo lookup for {Sub} failed: {Error}", sub, error.Message);
            return new KoraUser(sub, null, null);
        }
    }

    private static readonly TimeSpan LookupTimeout = TimeSpan.FromSeconds(5);

    private string? _userInfoEndpoint;
    private async Task<string> UserInfoEndpointAsync(CancellationToken cancellation)
    {
        if (_userInfoEndpoint is not null) return _userInfoEndpoint;
        using var json = JsonDocument.Parse(await http.CreateClient().GetStringAsync($"{options.Issuer}/.well-known/openid-configuration", cancellation));
        return _userInfoEndpoint = json.RootElement.GetProperty("userinfo_endpoint").GetString()!;
    }

    private static string? BearerToken(HttpContext? http)
    {
        if (http is null) return null;
        var header = http.Request.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return header["Bearer ".Length..];
        var query = http.Request.Query["access_token"].ToString();
        return string.IsNullOrEmpty(query) ? null : query;
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
