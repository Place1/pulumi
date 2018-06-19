#r "/home/matell/go/src/github.com/pulumi/pulumi/sdk/dotnet/Pulumi/bin/Debug/netstandard2.0/Pulumi.dll"
using AWS.S3;
using Pulumi;
using System;
using System.Text;
using System.Collections.Generic;

Config config = new Config("hello-dotnet");

// Create the bucket, and make it readable.
var bucket = new Bucket(config["name"], new BucketArgs {
        Acl = "public-read"
    }
);

// Add some content.  We can use contentBase64 for now, but next we'll want to build out the Assets pipeline so we
// can do a natural thing.
var content = new BucketObject($"{config["name"]}-content", new BucketObjectArgs {
       Acl = "public-read",
       Bucket = bucket,
       ContentBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes("Made with \u2764, Pulumi, and .NET")),
       ContentType = "text/plain; charset=utf8",
       Key = "hello.txt"
   }
);


// In addition to the logging here being nice, it actually forces us to block until the Tasks that represent the RPC
// calls to create the resources complete.
//
// TODO(ellismg): We need to come up with a solution here. We probably want to track all the pending tasks generated
// by Pulumi during execution and await them to complete in the host itself...
Console.WriteLine($"Bucket ID id  :  {bucket.Id.Result}");
Console.WriteLine($"Content ID id : {content.Id.Result}");
Console.WriteLine($"https://{bucket.BucketDomainName.Result}/hello.txt");
