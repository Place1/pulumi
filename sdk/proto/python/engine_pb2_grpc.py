# Generated by the gRPC Python protocol compiler plugin. DO NOT EDIT!
import grpc

import engine_pb2 as engine__pb2
from google.protobuf import empty_pb2 as google_dot_protobuf_dot_empty__pb2


class EngineStub(object):
  """Engine is an interface into the core engine responsible for orchestrating resource operations.
  """

  def __init__(self, channel):
    """Constructor.

    Args:
      channel: A grpc.Channel.
    """
    self.Log = channel.unary_unary(
        '/pulumirpc.Engine/Log',
        request_serializer=engine__pb2.LogRequest.SerializeToString,
        response_deserializer=google_dot_protobuf_dot_empty__pb2.Empty.FromString,
        )


class EngineServicer(object):
  """Engine is an interface into the core engine responsible for orchestrating resource operations.
  """

  def Log(self, request, context):
    """Log logs a global message in the engine, including errors and warnings.
    """
    context.set_code(grpc.StatusCode.UNIMPLEMENTED)
    context.set_details('Method not implemented!')
    raise NotImplementedError('Method not implemented!')


def add_EngineServicer_to_server(servicer, server):
  rpc_method_handlers = {
      'Log': grpc.unary_unary_rpc_method_handler(
          servicer.Log,
          request_deserializer=engine__pb2.LogRequest.FromString,
          response_serializer=google_dot_protobuf_dot_empty__pb2.Empty.SerializeToString,
      ),
  }
  generic_handler = grpc.method_handlers_generic_handler(
      'pulumirpc.Engine', rpc_method_handlers)
  server.add_generic_rpc_handlers((generic_handler,))
