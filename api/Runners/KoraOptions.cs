namespace DoPilot.Api.Runners;

public sealed class KoraOptions
{
    /// <summary>Blocks IAM issuer for the project tenant, e.g. https://iam.seliseblocks.com/&lt;tenantId&gt;.</summary>
    public required string Issuer { get; init; }

    /// <summary>Accepted token audiences (the project's app domain).</summary>
    public required string[] Audiences { get; init; }

    /// <summary>Blocks API base URL on the web app's cookie domain, used to check browser sessions.</summary>
    public required string ApiUrl { get; init; }

    /// <summary>Project tenant id (x-blocks-key).</summary>
    public required string TenantId { get; init; }

    /// <summary>Browser origins allowed to open the hub (the web app).</summary>
    public string[] AllowedOrigins { get; init; } = [];
}
